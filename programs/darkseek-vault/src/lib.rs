//! DarkSeek vault: player vaults, room escrow, settlement, the protocol fee
//! split, rebates, $DS staking, the $DS buyback auction and token locks.
//!
//! What the program guarantees, whoever runs the game server:
//!
//!  * USDC sits in one custody account the program owns; each player's share is
//!    recorded in their vault PDA. Only the owner can withdraw it, and a
//!    withdrawal never needs the game server.
//!  * The game server (the `authority`) can only lock a room stake for a player
//!    who approved a session, within that session's daily cap, refund it, and
//!    report a round's outcome. The program computes every payout from the
//!    published rules, out of that room's stakes only.
//!  * A round starts only when all ten seats are staked. (The program cannot tell
//!    whose wallets those are; that the house never plays is the game's promise.)
//!  * The 10% fee is split by fixed shares: $DS stakers, players who lost money
//!    (paid in $DS), the buyback (buys $DS and burns it) and the treasury. The
//!    admin can only ever take the treasury's share. Until $DS is recorded the
//!    whole fee goes to the treasury, so the other three pools hold nothing that
//!    the choice of the $DS mint could hand away.
//!  * The buyback and rebate pools leave custody only through a public
//!    descending price auction that anyone can fill. The buyback spends a fixed
//!    USDC target at a time, set once at launch and lowered by 2% after each
//!    round; the $DS it buys is burned in the same instruction.
//!  * Any round left unsettled for two hours can be unwound by anyone, and a
//!    seated player can leave a lobby that has been forming for 30 minutes on
//!    their own, with their whole stake.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};
use anchor_spl::token_2022::spl_token_2022::extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions};
use anchor_spl::token_interface as ti;

pub mod contexts;
pub mod error;
pub mod events;
pub mod rules;
pub mod state;

pub use contexts::*;
use error::VaultError;
use events::*;
use rules::*;
pub use state::*;

declare_id!("DarkHJqM8GMmCu7BWko6HMG4YgJgZ7jeEr2Qe967e5sE");

#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "DarkSeek vault",
    project_url: "https://thedarkseek.xyz",
    contacts: "link:https://github.com/nibblescreative-afk/darkseek/security/advisories/new",
    policy: "https://github.com/nibblescreative-afk/darkseek/blob/main/SECURITY.md",
    preferred_languages: "en,id",
    source_code: "https://github.com/nibblescreative-afk/darkseek"
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct InitArgs {
    /// the game server's key
    pub authority: Pubkey,
    /// [casual Hider, casual Seeker, pro Hider, pro Seeker] in base units
    pub stakes: [u64; 4],
    pub fee_bps: u16,
    pub split: FeeSplitBps,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct DsArgs {
    /// reference price until the first fill, in $DS base units per whole USDC
    pub genesis_price: u64,
    pub floor_price: u64,
    pub duration: i64,
    pub lot: u64,
    pub min_fill: u64,
    /// USDC the first buyback round spends (half the USDC value of the launch buy)
    pub buyback_target: u64,
}

#[program]
pub mod darkseek_vault {
    use super::*;

    // ------------------------------------------------------------------ admin

    /// Creates the config and the USDC custody. Only the program's upgrade
    /// authority may call it, once. Stakes, fee and split are fixed from here on.
    pub fn initialize(ctx: Context<Initialize>, args: InitArgs) -> Result<()> {
        require!(args.fee_bps <= MAX_FEE_BPS, VaultError::BadParams);
        require!(args.split.is_valid(), VaultError::BadParams);
        require!(args.stakes.iter().all(|s| *s > 0), VaultError::BadParams);
        let c = &mut ctx.accounts.config;
        c.admin = ctx.accounts.admin.key();
        c.pending_admin = Pubkey::default();
        c.authority = args.authority;
        c.mint = ctx.accounts.mint.key();
        c.custody = ctx.accounts.custody.key();
        c.decimals = ctx.accounts.mint.decimals;
        c.stakes = args.stakes;
        c.fee_bps = args.fee_bps;
        c.split = args.split;
        c.bump = ctx.bumps.config;
        emit!(ConfigInitialized { admin: c.admin, authority: c.authority, mint: c.mint, stakes: c.stakes, fee_bps: c.fee_bps, split: c.split });
        Ok(())
    }

    /// Replaces the game server's key.
    pub fn set_authority(ctx: Context<AdminOnly>, authority: Pubkey) -> Result<()> {
        let c = &mut ctx.accounts.config;
        let previous = c.authority;
        c.authority = authority;
        emit!(AuthoritySet { previous, authority });
        Ok(())
    }

    /// First step of handing the admin role over (to a multisig, say). The
    /// default key cancels a pending proposal.
    pub fn propose_admin(ctx: Context<AdminOnly>, pending_admin: Pubkey) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.pending_admin = pending_admin;
        emit!(AdminProposed { admin: c.admin, pending_admin });
        Ok(())
    }

    /// Second step: the proposed key signs to take the admin role.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        let previous = c.admin;
        c.admin = c.pending_admin;
        c.pending_admin = Pubkey::default();
        emit!(AdminAccepted { previous, admin: c.admin });
        Ok(())
    }

    /// Creates room `index` (1 to 6) with a fixed tier (0 casual, 1 pro).
    pub fn init_room(ctx: Context<InitRoom>, index: u8, tier: u8) -> Result<()> {
        require!((1..=ROOMS).contains(&index), VaultError::BadParams);
        require!(tier < TIERS, VaultError::BadParams);
        let r = &mut ctx.accounts.room;
        r.index = index;
        r.tier = tier;
        r.status = STATUS_SETTLED; // ready for round 1
        r.round = 0;
        r.bump = ctx.bumps.room;
        emit!(RoomCreated { room: index, tier });
        Ok(())
    }

    /// Records the $DS mint, the buyback target and the auction's parameters,
    /// once. The mint, SPL Token or Token 2022, must have a fixed supply (no mint
    /// authority, no freeze authority), six decimals, at most one billion
    /// tokens and no extension but metadata, as pump.fun creates its coins.
    /// Nothing recorded here can change later.
    pub fn init_ds(ctx: Context<InitDs>, args: DsArgs) -> Result<()> {
        let m = &ctx.accounts.ds_mint;
        require!(m.mint_authority.is_none() && m.freeze_authority.is_none(), VaultError::DsNotFixed);
        require!(m.decimals == DS_DECIMALS, VaultError::BadParams);
        // pump.fun's one billion, or less after burns; a Mayhem mode coin has two billion
        require!(m.supply > 0 && m.supply <= DS_TOTAL_SUPPLY, VaultError::DsSupply);
        check_mint_extensions(&m.to_account_info())?;
        // bounded settings: a floor at most a thousand times under the genesis price, a descent of
        // an hour to a week, a lot of at most 100 000 USDC, a first target of at most 1 000 000 USDC
        require!(ds_args_ok(&args, ctx.accounts.config.usdc_unit()), VaultError::BadParams);
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.config;
        require!(!c.ds_ready(), VaultError::DsAlreadySet);
        c.ds_mint = m.key();
        c.ds_custody = ctx.accounts.ds_custody.key();
        c.ds_token_program = ctx.accounts.ds_token_program.key();
        c.buyback_target = args.buyback_target;
        c.buyback_target_initial = args.buyback_target;
        c.auction = Auction {
            last_price: args.genesis_price,
            started_at: now,
            floor_price: args.floor_price,
            duration: args.duration,
            lot: args.lot,
            min_fill: args.min_fill,
        };
        emit!(DsConfigured {
            ds_mint: c.ds_mint,
            ds_token_program: c.ds_token_program,
            buyback_target: args.buyback_target,
            genesis_price: args.genesis_price,
            floor_price: args.floor_price,
            duration: args.duration,
            lot: args.lot,
            min_fill: args.min_fill,
        });
        Ok(())
    }

    /// The admin takes protocol revenue out of the treasury, and nothing else.
    pub fn sweep_treasury(ctx: Context<SweepTreasury>, amount: u64) -> Result<()> {
        let a = &ctx.accounts;
        require!(amount > 0 && amount <= a.config.treasury, VaultError::BadAmount);
        pay_out(&a.token_program, &a.config, &a.custody, &a.mint, &a.to, amount)?;
        let c = &mut ctx.accounts.config;
        c.treasury -= amount;
        c.totals.treasury_swept = c.totals.treasury_swept.checked_add(amount).ok_or(VaultError::Overflow)?;
        emit!(TreasurySwept { to: ctx.accounts.to.key(), amount, treasury: c.treasury });
        Ok(())
    }

    // ------------------------------------------------------------------ players

    /// Creates `owner`'s vault. Anyone may pay for it; the owner need not sign.
    pub fn open_vault(ctx: Context<OpenVault>) -> Result<()> {
        // empty seats are marked by the all zero key: no vault ever belongs to it
        require_keys_neq!(ctx.accounts.owner.key(), Pubkey::default(), VaultError::BadParams);
        let v = &mut ctx.accounts.vault;
        v.owner = ctx.accounts.owner.key();
        v.bump = ctx.bumps.vault;
        emit!(VaultOpened { owner: v.owner, payer: ctx.accounts.payer.key() });
        Ok(())
    }

    /// The owner lets the game server lock room stakes for them until
    /// `expires_at`, at most `daily_cap` a day. A past `expires_at` revokes it.
    pub fn set_session(ctx: Context<OwnerOnly>, daily_cap: u64, expires_at: i64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(expires_at <= now.saturating_add(MAX_SESSION_SECS), VaultError::BadParams);
        let v = &mut ctx.accounts.vault;
        v.session_expires = expires_at;
        v.daily_cap = daily_cap;
        emit!(SessionSet { owner: v.owner, daily_cap, expires_at });
        Ok(())
    }

    /// Moves USDC from the signer's token account into `vault` (own or anyone's).
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::BadAmount);
        let a = &ctx.accounts;
        pay_in(&a.token_program, &a.from, &a.mint, &a.custody, &a.depositor, amount)?;
        let v = &mut ctx.accounts.vault;
        v.balance = v.balance.checked_add(amount).ok_or(VaultError::Overflow)?;
        emit!(Deposited { owner: v.owner, depositor: ctx.accounts.depositor.key(), amount });
        Ok(())
    }

    /// The owner takes free USDC out. Needs nothing from the game server.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let a = &ctx.accounts;
        require!(amount > 0 && amount <= a.vault.balance, VaultError::BadAmount);
        pay_out(&a.token_program, &a.config, &a.custody, &a.mint, &a.to, amount)?;
        ctx.accounts.vault.balance -= amount;
        emit!(Withdrawn { owner: ctx.accounts.owner.key(), to: ctx.accounts.to.key(), amount });
        Ok(())
    }

    /// The owner pays the protocol from their vault (a shop purchase).
    pub fn charge(ctx: Context<Charge>, amount: u64) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        require!(amount > 0 && amount <= v.balance, VaultError::BadAmount);
        v.balance -= amount;
        let c = &mut ctx.accounts.config;
        c.treasury = c.treasury.checked_add(amount).ok_or(VaultError::Overflow)?;
        emit!(Charged { owner: v.owner, amount });
        Ok(())
    }

    /// The owner pays another player's vault (a P2P purchase).
    pub fn pay(ctx: Context<Pay>, amount: u64) -> Result<()> {
        require_keys_neq!(ctx.accounts.from.key(), ctx.accounts.to.key(), VaultError::BadParams);
        let from = &mut ctx.accounts.from;
        require!(amount > 0 && amount <= from.balance, VaultError::BadAmount);
        from.balance -= amount;
        let to = &mut ctx.accounts.to;
        to.balance = to.balance.checked_add(amount).ok_or(VaultError::Overflow)?;
        emit!(Paid { from: from.owner, to: to.owner, amount });
        Ok(())
    }

    // ------------------------------------------------------------------ rooms (game server)

    /// Puts the stake for `slot` (0 and 1 Seekers, 2 to 9 Hiders) into the room.
    /// Needs the player's session and counts toward its daily cap.
    pub fn lock_stake(ctx: Context<LockStake>, round: u64, slot: u8) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &ctx.accounts.config;
        let r = &mut ctx.accounts.room;
        let v = &mut ctx.accounts.vault;
        require!((slot as usize) < SEATS, VaultError::BadSlot);
        require_keys_neq!(v.owner, Pubkey::default(), VaultError::BadParams);
        // only ever the next round number: a higher one would leave the room with no round after it
        let next = r.round.checked_add(1).ok_or(VaultError::WrongRound)?;
        match r.status {
            STATUS_SETTLED => {
                require!(round == next, VaultError::WrongRound);
                r.reset(round);
            }
            STATUS_OPEN => {
                if round != r.round {
                    // a lobby nobody sits in may move on to the next round (a start that never landed, say)
                    require!(round == next && r.seats.iter().all(|s| s.is_empty()), VaultError::WrongRound);
                    r.reset(round);
                }
            }
            _ => return err!(VaultError::RoundRunning),
        }
        // the first seat in an empty room: the lobby's clock (for leaving it on one's own) starts now
        if r.seats.iter().all(|s| s.is_empty()) {
            r.started_at = now;
        }
        require!(r.seats[slot as usize].is_empty(), VaultError::SeatTaken);
        require!(!r.seats.iter().any(|s| s.owner == v.owner), VaultError::AlreadySeated);
        let stake = c.stake_for(r.tier, slot);
        spend_session(v, stake, now)?;
        v.locked = v.locked.checked_add(stake).ok_or(VaultError::Overflow)?;
        r.seats[slot as usize] = Seat { owner: v.owner, stake };
        r.pot = r.pot.checked_add(stake).ok_or(VaultError::Overflow)?;
        r.updated_at = now;
        emit!(StakeLocked { room: r.index, round, slot, owner: v.owner, stake });
        Ok(())
    }

    /// Someone left before the round started: their whole stake goes back.
    pub fn unlock_stake(ctx: Context<LockStake>, round: u64, slot: u8) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let r = &mut ctx.accounts.room;
        let v = &mut ctx.accounts.vault;
        require!(r.status == STATUS_OPEN && r.round == round, VaultError::WrongRound);
        require!((slot as usize) < SEATS, VaultError::BadSlot);
        let seat = r.seats[slot as usize];
        require!(!seat.is_empty() && seat.owner == v.owner, VaultError::BadSlot);
        v.locked = v.locked.checked_sub(seat.stake).ok_or(VaultError::Overflow)?;
        v.balance = v.balance.checked_add(seat.stake).ok_or(VaultError::Overflow)?;
        r.pot -= seat.stake;
        r.seats[slot as usize] = Seat::default();
        r.updated_at = now;
        emit!(StakeUnlocked { room: r.index, round, slot, owner: v.owner, stake: seat.stake });
        Ok(())
    }

    /// A seated player leaves an open lobby on their own, with their whole stake,
    /// once the lobby has been forming for `LEAVE_AFTER_SECS`. While they stay
    /// seated the room is never empty, so no lock or unlock restarts that clock;
    /// only their session lets the game server seat them again in a fresh lobby.
    pub fn leave_seat(ctx: Context<LeaveSeat>, round: u64, slot: u8) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let r = &mut ctx.accounts.room;
        let v = &mut ctx.accounts.vault;
        require!(r.status == STATUS_OPEN && r.round == round, VaultError::WrongRound);
        require!((slot as usize) < SEATS, VaultError::BadSlot);
        let seat = r.seats[slot as usize];
        require!(!seat.is_empty() && seat.owner == v.owner, VaultError::BadSlot);
        require!(now >= r.started_at.saturating_add(LEAVE_AFTER_SECS), VaultError::TooEarly);
        v.locked = v.locked.checked_sub(seat.stake).ok_or(VaultError::Overflow)?;
        v.balance = v.balance.checked_add(seat.stake).ok_or(VaultError::Overflow)?;
        r.pot -= seat.stake;
        r.seats[slot as usize] = Seat::default();
        r.updated_at = now;
        emit!(SeatLeft { room: r.index, round, slot, owner: v.owner, stake: seat.stake });
        Ok(())
    }

    /// All ten seats are staked: the round goes live, the fee is taken seat by
    /// seat and split by the fixed shares (all of it to the treasury until $DS is recorded).
    pub fn start_round(ctx: Context<RoomOp>, round: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.config;
        let r = &mut ctx.accounts.room;
        require!(r.status == STATUS_OPEN && r.round == round, VaultError::WrongRound);
        require!(r.is_full(), VaultError::RoomNotFull);
        let mut gross = 0u64;
        let mut fee = 0u64;
        for seat in r.seats.iter() {
            gross = gross.checked_add(seat.stake).ok_or(VaultError::Overflow)?;
            // seat by seat, so every seat of a role keeps the same net stake
            fee = fee.checked_add(fee_on(seat.stake, c.fee_bps)).ok_or(VaultError::Overflow)?;
        }
        let parts = fee_parts(fee, &c.split, c.ds_ready());
        c.staker_pool = c.staker_pool.checked_add(parts.stakers).ok_or(VaultError::Overflow)?;
        (c.reward_per_ds, c.reward_carry) = accrue_rewards(c.reward_per_ds, c.reward_carry, c.ds_staked, parts.stakers)?;
        c.rebate_pool = c.rebate_pool.checked_add(parts.rebate).ok_or(VaultError::Overflow)?;
        c.buyback_pool = c.buyback_pool.checked_add(parts.buyback).ok_or(VaultError::Overflow)?;
        c.treasury = c.treasury.checked_add(parts.treasury).ok_or(VaultError::Overflow)?;
        let t = &mut c.totals;
        t.rounds_started += 1;
        t.staked = t.staked.checked_add(gross).ok_or(VaultError::Overflow)?;
        t.fees = t.fees.checked_add(fee).ok_or(VaultError::Overflow)?;
        t.to_stakers = t.to_stakers.checked_add(parts.stakers).ok_or(VaultError::Overflow)?;
        t.to_rebate = t.to_rebate.checked_add(parts.rebate).ok_or(VaultError::Overflow)?;
        t.to_buyback = t.to_buyback.checked_add(parts.buyback).ok_or(VaultError::Overflow)?;
        t.to_treasury = t.to_treasury.checked_add(parts.treasury).ok_or(VaultError::Overflow)?;
        r.pot -= fee;
        r.fee = fee;
        r.rebate = parts.rebate;
        r.status = STATUS_LIVE;
        r.started_at = now;
        r.updated_at = now;
        emit!(RoundStarted {
            room: r.index,
            round,
            tier: r.tier,
            owners: r.seats.map(|s| s.owner),
            gross,
            fee,
            to_stakers: parts.stakers,
            to_rebate: parts.rebate,
            to_buyback: parts.buyback,
            to_treasury: parts.treasury,
            pot: r.pot,
        });
        Ok(())
    }

    /// Pays the round out by the rules. `outcomes[i]` is Hider slot 2 + i:
    /// `SURVIVED`, or the Seeker slot (0 or 1) that caught it. The remaining
    /// accounts are the ten seated players' vaults, in slot order.
    pub fn settle_round<'info>(ctx: Context<'info, RoomOp<'info>>, round: u64, outcomes: [u8; HIDER_SEATS]) -> Result<()> {
        let c = &mut ctx.accounts.config;
        let r = &mut ctx.accounts.room;
        require!(r.status == STATUS_LIVE && r.round == round, VaultError::WrongRound);
        let payouts = payouts_for(&c.stakes, c.fee_bps, r.tier, &outcomes)?;
        let paid = payouts.iter().try_fold(0u64, |s, p| s.checked_add(*p)).ok_or(VaultError::Overflow)?;
        require!(paid <= r.pot, VaultError::Overflow);
        let dust = r.pot - paid;

        // players who lost money share this round's rebate equally, as USDC credit
        // that `claim_rebate` pays in $DS bought with the rebate pool
        let losers = losers_mask(&r.seats.map(|s| s.stake), &payouts);
        let count = losers.count_ones() as u64;
        let rebate_usdc = r.rebate.checked_div(count).unwrap_or(0);
        credit_rebates(c, rebate_usdc * count)?;

        let mut vaults = ctx.remaining_accounts.iter();
        for slot in 0..SEATS {
            let info = vaults.next().ok_or(VaultError::MissingVault)?;
            let credit = if losers & (1 << slot) != 0 { rebate_usdc } else { 0 };
            credit_vault(info, &r.seats[slot], payouts[slot], credit)?;
        }
        c.treasury = c.treasury.checked_add(dust).ok_or(VaultError::Overflow)?;
        c.totals.rounds_settled += 1;
        r.finish();
        emit!(RoundSettled { room: r.index, round, seekers_won: outcomes.iter().all(|o| *o != SURVIVED), outcomes, payouts, losers, rebate_usdc, dust });
        Ok(())
    }

    /// The game server gives up on a round. Before the start every stake goes
    /// back in full; after it, less the fee already taken. The remaining
    /// accounts are the seated players' vaults, in slot order.
    pub fn cancel_round<'info>(ctx: Context<'info, RoomOp<'info>>, round: u64) -> Result<()> {
        let c = &mut ctx.accounts.config;
        let r = &mut ctx.accounts.room;
        require!((r.status == STATUS_OPEN || r.status == STATUS_LIVE) && r.round == round, VaultError::WrongRound);
        refund_all(c, r, ctx.remaining_accounts, false)
    }

    /// Anyone may unwind a round that made no progress for two hours: a lobby
    /// nobody joined or left (full refunds) or a live round never settled
    /// (refunds less the fee).
    pub fn abort_stale_round<'info>(ctx: Context<'info, AbortStale<'info>>, round: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.config;
        let r = &mut ctx.accounts.room;
        require!(r.round == round, VaultError::WrongRound);
        let since = match r.status {
            STATUS_OPEN => r.updated_at,
            STATUS_LIVE => r.started_at,
            _ => return err!(VaultError::WrongRound),
        };
        require!(now >= since.saturating_add(STALE_AFTER_SECS), VaultError::NotStale);
        refund_all(c, r, ctx.remaining_accounts, true)
    }

    // ------------------------------------------------------------------ $DS: deposits, staking, rebates

    /// Moves $DS from the signer's token account into `vault` (own or anyone's).
    pub fn deposit_ds(ctx: Context<DepositDs>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::BadAmount);
        let a = &ctx.accounts;
        ds_transfer(&a.ds_token_program, &a.from, &a.ds_mint, &a.ds_custody, a.depositor.to_account_info(), None, amount)?;
        let v = &mut ctx.accounts.vault;
        v.ds_balance = v.ds_balance.checked_add(amount).ok_or(VaultError::Overflow)?;
        emit!(DsDeposited { owner: v.owner, depositor: ctx.accounts.depositor.key(), amount });
        Ok(())
    }

    /// The owner takes free $DS (rebates, deposits, unstaked) out of their vault.
    pub fn withdraw_ds(ctx: Context<WithdrawDs>, amount: u64) -> Result<()> {
        let a = &ctx.accounts;
        require!(amount > 0 && amount <= a.vault.ds_balance, VaultError::BadAmount);
        let seeds: &[&[u8]] = &[b"config", &[a.config.bump]];
        ds_transfer(&a.ds_token_program, &a.ds_custody, &a.ds_mint, &a.to, a.config.to_account_info(), Some(seeds), amount)?;
        ctx.accounts.vault.ds_balance -= amount;
        emit!(DsWithdrawn { owner: ctx.accounts.owner.key(), to: ctx.accounts.to.key(), amount });
        Ok(())
    }

    /// Stakes free $DS from the vault. Stakers share 10% of every fee (1% of
    /// every stake) in USDC, pro rata to stake, from the next round that starts.
    pub fn stake_ds(ctx: Context<StakeDs>, amount: u64) -> Result<()> {
        let c = &mut ctx.accounts.config;
        let v = &mut ctx.accounts.vault;
        require!(c.ds_ready(), VaultError::DsNotReady);
        require!(amount > 0 && amount <= v.ds_balance, VaultError::BadAmount);
        sync_rewards(v, c.reward_per_ds)?;
        v.ds_balance -= amount;
        v.ds_staked = v.ds_staked.checked_add(amount).ok_or(VaultError::Overflow)?;
        c.ds_staked = c.ds_staked.checked_add(amount).ok_or(VaultError::Overflow)?;
        emit!(DsStaked { owner: v.owner, amount, staked: v.ds_staked, total_staked: c.ds_staked });
        Ok(())
    }

    /// Unstakes $DS back to the vault's free balance. No lockup.
    pub fn unstake_ds(ctx: Context<StakeDs>, amount: u64) -> Result<()> {
        let c = &mut ctx.accounts.config;
        let v = &mut ctx.accounts.vault;
        require!(amount > 0 && amount <= v.ds_staked, VaultError::BadAmount);
        sync_rewards(v, c.reward_per_ds)?;
        v.ds_staked -= amount;
        v.ds_balance = v.ds_balance.checked_add(amount).ok_or(VaultError::Overflow)?;
        c.ds_staked -= amount;
        emit!(DsUnstaked { owner: v.owner, amount, staked: v.ds_staked, total_staked: c.ds_staked });
        Ok(())
    }

    /// Moves a vault's USDC staking rewards into its free balance.
    pub fn claim_rewards(ctx: Context<ClaimForVault>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        let v = &mut ctx.accounts.vault;
        sync_rewards(v, c.reward_per_ds)?;
        let amount = v.rewards;
        require!(amount > 0, VaultError::NothingToClaim);
        c.staker_pool = c.staker_pool.checked_sub(amount).ok_or(VaultError::Overflow)?;
        v.rewards = 0;
        v.balance = v.balance.checked_add(amount).ok_or(VaultError::Overflow)?;
        emit!(RewardsClaimed { owner: v.owner, amount });
        Ok(())
    }

    /// Turns a vault's rebate credit into $DS at the average price the rebate
    /// pool paid for the $DS in the reserve, as far as the reserve reaches; the
    /// rest waits for the auction's next purchases. Anyone may call it: the $DS
    /// can only land in that vault.
    pub fn claim_rebate(ctx: Context<ClaimForVault>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        let v = &mut ctx.accounts.vault;
        let (usdc, ds) = rebate_claim(v.rebate_credit, c.ds_reserve, c.reserve_cost);
        require!(usdc > 0, VaultError::NothingToClaim);
        c.ds_reserve -= ds;
        c.reserve_cost -= usdc;
        c.rebate_credits -= usdc;
        v.rebate_credit -= usdc;
        v.ds_balance = v.ds_balance.checked_add(ds).ok_or(VaultError::Overflow)?;
        c.totals.rebates_claimed = c.totals.rebates_claimed.checked_add(usdc).ok_or(VaultError::Overflow)?;
        c.totals.ds_rebated = c.totals.ds_rebated.checked_add(ds).ok_or(VaultError::Overflow)?;
        emit!(RebateClaimed { owner: v.owner, usdc, ds, credit_left: v.rebate_credit });
        Ok(())
    }

    // ------------------------------------------------------------------ $DS: buyback auction

    /// Sells up to `max_ds` $DS to the program at the current auction price,
    /// for at least `min_usdc`. The program pays from the rebate pool at any
    /// time, and from the buyback pool only in buyback rounds: a round opens once
    /// the pool holds the whole target and spends exactly the target. $DS bought
    /// for the buyback is burned here and now; $DS bought for rebates joins the
    /// reserve. When a round's budget is spent, the next target is 98% of this
    /// one. The price then restarts at 1.5 times this fill, or 3 times when this
    /// fill came within ten minutes of the one before.
    pub fn sell_ds(ctx: Context<SellDs>, max_ds: u64, min_usdc: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &ctx.accounts.config;
        let price = auction_price(&c.auction, now);
        let buyback = buyback_available(c.buyback_pool, c.buyback_target, c.buyback_round_left);
        let on_offer = (buyback as u128 + c.rebate_pool as u128).min(c.auction.lot as u128) as u64;
        let fill = auction_fill(price, max_ds, buyback, c.rebate_pool, c.auction.lot, c.usdc_unit()).ok_or(VaultError::BelowMinFill)?;
        // dust fills would only move the price: below the minimum, a fill must take all that is on offer
        require!(fill.usdc >= c.auction.min_fill || fill.usdc == on_offer, VaultError::BelowMinFill);
        require!(fill.usdc >= min_usdc, VaultError::PriceMoved);

        let a = &ctx.accounts;
        if fill.ds_burned > 0 {
            ti::burn(
                CpiContext::new(
                    a.ds_token_program.key(),
                    ti::Burn { mint: a.ds_mint.to_account_info(), from: a.seller_ds.to_account_info(), authority: a.seller.to_account_info() },
                ),
                fill.ds_burned,
            )?;
        }
        if fill.ds_to_reserve > 0 {
            ds_transfer(&a.ds_token_program, &a.seller_ds, &a.ds_mint, &a.ds_custody, a.seller.to_account_info(), None, fill.ds_to_reserve)?;
        }
        pay_out(&a.token_program, &a.config, &a.custody, &a.mint, &a.seller_usdc, fill.usdc)?;

        let c = &mut ctx.accounts.config;
        c.buyback_pool -= fill.from_buyback;
        c.rebate_pool -= fill.from_rebate;
        c.ds_reserve = c.ds_reserve.checked_add(fill.ds_to_reserve).ok_or(VaultError::Overflow)?;
        c.reserve_cost = c.reserve_cost.checked_add(fill.from_rebate).ok_or(VaultError::Overflow)?;
        if c.buyback_target > 0 && fill.from_buyback > 0 {
            // this fill opens the round if none was open; the round closes when its budget is spent
            let budget = if c.buyback_round_left > 0 { c.buyback_round_left } else { c.buyback_target };
            c.buyback_round_left = budget - fill.from_buyback;
            if c.buyback_round_left == 0 {
                c.buybacks_done += 1;
                c.buyback_target = next_buyback_target(c.buyback_target);
            }
        }
        // a fill soon after the one before restarts the price twice as far up
        let refill = c.totals.buyback_spent > 0 || c.totals.rebate_spent > 0;
        let quick = refill && now < c.auction.started_at.saturating_add(QUICK_REFILL_SECS);
        c.auction.last_price = next_reference_price(price, quick);
        c.auction.started_at = now;
        let t = &mut c.totals;
        t.buyback_spent = t.buyback_spent.checked_add(fill.from_buyback).ok_or(VaultError::Overflow)?;
        t.rebate_spent = t.rebate_spent.checked_add(fill.from_rebate).ok_or(VaultError::Overflow)?;
        t.ds_burned = t.ds_burned.checked_add(fill.ds_burned).ok_or(VaultError::Overflow)?;
        t.ds_to_reserve = t.ds_to_reserve.checked_add(fill.ds_to_reserve).ok_or(VaultError::Overflow)?;
        emit!(Buyback {
            seller: ctx.accounts.seller.key(),
            price,
            usdc: fill.usdc,
            ds: fill.ds,
            ds_burned: fill.ds_burned,
            ds_to_reserve: fill.ds_to_reserve,
            from_buyback: fill.from_buyback,
            from_rebate: fill.from_rebate,
            buyback_pool: c.buyback_pool,
            rebate_pool: c.rebate_pool,
            buyback_target: c.buyback_target,
            buybacks_done: c.buybacks_done,
            buyback_round_left: c.buyback_round_left,
        });
        Ok(())
    }

    // ------------------------------------------------------------------ token locks

    /// Locks `total` tokens of any mint (SPL Token or Token 2022) for
    /// `beneficiary`: nothing before `cliff`, then a straight line from `start`
    /// to `end`. Anyone may lock their own tokens this way; nobody can revoke
    /// a lock or speed it up.
    pub fn create_vesting(ctx: Context<CreateVesting>, id: u64, total: u64, start: i64, cliff: i64, end: i64) -> Result<()> {
        require!(total > 0, VaultError::BadAmount);
        require!(start < end && cliff >= start && cliff <= end, VaultError::BadParams);
        // a fee, hook, pause or delegate on the mint could leave the lock short or empty
        check_mint_extensions(&ctx.accounts.mint.to_account_info())?;
        let a = &ctx.accounts;
        ds_transfer(&a.token_program, &a.from, &a.mint, &a.vesting_tokens, a.funder.to_account_info(), None, total)?;
        let v = &mut ctx.accounts.vesting;
        v.beneficiary = ctx.accounts.beneficiary.key();
        v.mint = ctx.accounts.mint.key();
        v.funder = ctx.accounts.funder.key();
        v.id = id;
        v.total = total;
        v.claimed = 0;
        v.start = start;
        v.cliff = cliff;
        v.end = end;
        v.bump = ctx.bumps.vesting;
        emit!(VestingCreated { vesting: v.key(), beneficiary: v.beneficiary, mint: v.mint, funder: v.funder, id, total, start, cliff, end });
        Ok(())
    }

    /// Releases what has vested so far to the beneficiary's token account.
    pub fn claim_vesting(ctx: Context<ClaimVesting>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let v = &ctx.accounts.vesting;
        let amount = vested(v.total, v.start, v.cliff, v.end, now) - v.claimed;
        require!(amount > 0, VaultError::NothingToClaim);
        let (mint_key, beneficiary, id, bump) = (v.mint, v.beneficiary, v.id.to_le_bytes(), v.bump);
        let seeds: &[&[u8]] = &[b"vesting", mint_key.as_ref(), beneficiary.as_ref(), &id, &[bump]];
        let a = &ctx.accounts;
        ds_transfer(&a.token_program, &a.vesting_tokens, &a.mint, &a.to, a.vesting.to_account_info(), Some(seeds), amount)?;
        let v = &mut ctx.accounts.vesting;
        v.claimed += amount;
        emit!(VestingClaimed { vesting: v.key(), beneficiary: v.beneficiary, amount, claimed: v.claimed });
        Ok(())
    }
}

// ---------------------------------------------------------------------- helpers

/// Tokens from a signer's account into a program account.
fn pay_in<'info>(
    token_program: &Program<'info, Token>,
    from: &Account<'info, TokenAccount>,
    mint: &Account<'info, Mint>,
    to: &Account<'info, TokenAccount>,
    authority: &Signer<'info>,
    amount: u64,
) -> Result<()> {
    token::transfer_checked(
        CpiContext::new(
            token_program.key(),
            TransferChecked { from: from.to_account_info(), mint: mint.to_account_info(), to: to.to_account_info(), authority: authority.to_account_info() },
        ),
        amount,
        mint.decimals,
    )
}

/// Tokens out of a custody account the config PDA owns.
fn pay_out<'info>(
    token_program: &Program<'info, Token>,
    config: &Account<'info, Config>,
    from: &Account<'info, TokenAccount>,
    mint: &Account<'info, Mint>,
    to: &Account<'info, TokenAccount>,
    amount: u64,
) -> Result<()> {
    let seeds: &[&[u8]] = &[b"config", &[config.bump]];
    token::transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked { from: from.to_account_info(), mint: mint.to_account_info(), to: to.to_account_info(), authority: config.to_account_info() },
            &[seeds],
        ),
        amount,
        mint.decimals,
    )
}

/// $DS or locked tokens between token accounts of either token program. With
/// `seeds`, the program signs for the `authority` PDA.
fn ds_transfer<'info>(
    token_program: &Interface<'info, ti::TokenInterface>,
    from: &InterfaceAccount<'info, ti::TokenAccount>,
    mint: &InterfaceAccount<'info, ti::Mint>,
    to: &InterfaceAccount<'info, ti::TokenAccount>,
    authority: AccountInfo<'info>,
    seeds: Option<&[&[u8]]>,
    amount: u64,
) -> Result<()> {
    let accounts = ti::TransferChecked { from: from.to_account_info(), mint: mint.to_account_info(), to: to.to_account_info(), authority };
    let signer: &[&[&[u8]]] = match seeds {
        Some(s) => &[s],
        None => &[],
    };
    ti::transfer_checked(CpiContext::new_with_signer(token_program.key(), accounts, signer), amount, mint.decimals)
}

/// A Token 2022 mint may carry metadata and nothing else: a permanent
/// delegate, transfer hook, transfer fee, default frozen state, close
/// authority, non transferability, confidential transfers or pausing could
/// take, tax, freeze or block tokens the program holds. SPL Token mints have
/// no extensions.
fn check_mint_extensions(mint: &AccountInfo) -> Result<()> {
    if *mint.owner != anchor_spl::token_2022::ID {
        return Ok(());
    }
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<anchor_spl::token_2022::spl_token_2022::state::Mint>::unpack(&data)?;
    let allowed = state.get_extension_types()?.iter().all(|t| matches!(t, ExtensionType::MetadataPointer | ExtensionType::TokenMetadata));
    require!(allowed, VaultError::MintExtensionNotAllowed);
    Ok(())
}

/// Records USDC of rebate as credit owed to players (the vault side is in `credit_vault`).
fn credit_rebates(c: &mut Account<Config>, usdc: u64) -> Result<()> {
    c.rebate_credits = c.rebate_credits.checked_add(usdc).ok_or(VaultError::Overflow)?;
    c.totals.rebates_credited = c.totals.rebates_credited.checked_add(usdc).ok_or(VaultError::Overflow)?;
    Ok(())
}

/// The game server spends a player's free USDC on a room stake: only within an
/// active session and its daily cap.
fn spend_session(v: &mut Vault, amount: u64, now: i64) -> Result<()> {
    require!(v.session_expires > now, VaultError::NoSession);
    let day = now.div_euclid(DAY);
    if day != v.spent_day {
        v.spent_day = day;
        v.spent = 0;
    }
    let spent = v.spent.checked_add(amount).ok_or(VaultError::Overflow)?;
    require!(spent <= v.daily_cap, VaultError::OverDailyCap);
    require!(amount <= v.balance, VaultError::InsufficientFunds);
    v.spent = spent;
    v.balance -= amount;
    Ok(())
}

/// Brings a vault's staking rewards up to the current accumulator.
fn sync_rewards(v: &mut Vault, acc: u128) -> Result<()> {
    let e = earned(v.ds_staked, acc, v.reward_index)?;
    v.rewards = v.rewards.checked_add(e).ok_or(VaultError::Overflow)?;
    v.reward_index = acc;
    Ok(())
}

/// Ends a seat: its stake leaves `locked`, `amount` USDC lands in the vault and
/// `rebate` USDC is added to its rebate credit. The vault must belong to the
/// seat's owner.
fn credit_vault<'info>(info: &'info AccountInfo<'info>, seat: &Seat, amount: u64, rebate: u64) -> Result<()> {
    require!(info.is_writable, VaultError::MissingVault);
    // only this program creates vaults, always at the owner's PDA: type, program and owner identify it
    let mut vault: Account<'info, Vault> = Account::try_from(info)?;
    require_keys_eq!(vault.owner, seat.owner, VaultError::MissingVault);
    vault.locked = vault.locked.checked_sub(seat.stake).ok_or(VaultError::Overflow)?;
    vault.balance = vault.balance.checked_add(amount).ok_or(VaultError::Overflow)?;
    vault.rebate_credit = vault.rebate_credit.checked_add(rebate).ok_or(VaultError::Overflow)?;
    vault.exit(&crate::ID)?;
    Ok(())
}

/// Returns every seated stake: in full before the start, less the fee after it.
/// After the start every seat lost the fee, so the round's rebate is shared
/// among all seats as rebate credit. The rest of the fee stays where it went;
/// any rounding goes to the treasury.
fn refund_all<'info>(c: &mut Account<'info, Config>, r: &mut Account<'info, Room>, remaining: &'info [AccountInfo<'info>], stale: bool) -> Result<()> {
    let after_start = r.status == STATUS_LIVE;
    let seated = r.seats.iter().filter(|s| !s.is_empty()).count() as u64;
    let rebate_usdc = if after_start { r.rebate.checked_div(seated).unwrap_or(0) } else { 0 };
    credit_rebates(c, rebate_usdc * seated)?;
    let mut vaults = remaining.iter();
    let mut refunds = [0u64; SEATS];
    let mut left = r.pot;
    for slot in 0..SEATS {
        let seat = r.seats[slot];
        if seat.is_empty() {
            continue;
        }
        let back = if after_start { seat.stake - fee_on(seat.stake, c.fee_bps) } else { seat.stake };
        let info = vaults.next().ok_or(VaultError::MissingVault)?;
        credit_vault(info, &seat, back, rebate_usdc)?;
        left = left.checked_sub(back).ok_or(VaultError::Overflow)?;
        refunds[slot] = back;
    }
    c.treasury = c.treasury.checked_add(left).ok_or(VaultError::Overflow)?;
    c.totals.rounds_refunded += 1;
    r.finish();
    emit!(RoundRefunded { room: r.index, round: r.round, after_start, stale, refunds, rebate_usdc });
    Ok(())
}
