//! Accounts the program owns and the constants that shape them.

use anchor_lang::prelude::*;

/// Seats in a room: slots 0 and 1 are Seekers, 2 to 9 are Hiders.
pub const SEATS: usize = 10;
pub const SEEKER_SEATS: usize = 2;
pub const HIDER_SEATS: usize = 8;
/// Settle outcome for a Hider who was still free when the hunt ended.
pub const SURVIVED: u8 = 0xFF;

pub const STATUS_OPEN: u8 = 0;
pub const STATUS_LIVE: u8 = 1;
pub const STATUS_SETTLED: u8 = 2;

/// Rooms 1 to 6 exist; each has a fixed tier (0 casual, 1 pro).
pub const ROOMS: u8 = 6;
pub const TIERS: u8 = 2;

pub const DAY: i64 = 86_400;
/// Longest game session a player can approve.
pub const MAX_SESSION_SECS: i64 = 90 * DAY;
/// After this long without progress anyone may unwind a round.
pub const STALE_AFTER_SECS: i64 = 2 * 3_600;
/// A seated player may leave an open lobby on their own once it has been forming this long.
pub const LEAVE_AFTER_SECS: i64 = 30 * 60;

pub const BPS: u64 = 10_000;
/// Highest protocol fee the program accepts at initialization (20%).
pub const MAX_FEE_BPS: u16 = 2_000;

/// $DS has six decimals and a fixed supply.
pub const DS_DECIMALS: u8 = 6;
/// Fixed point scale of the staking reward accumulator.
pub const REWARD_SCALE: u128 = 1_000_000_000_000;
/// A new auction starts at 1.5 times the price of the last fill.
pub const AUCTION_RESTART_BPS: u64 = 15_000;
/// A fill this soon after the one before counts double for the restart (3 times its price).
pub const QUICK_REFILL_SECS: i64 = 10 * 60;
/// Shortest and longest descent from the start price to the floor that `init_ds` accepts.
pub const MIN_AUCTION_SECS: i64 = 3_600;
pub const MAX_AUCTION_SECS: i64 = 7 * DAY;
/// The floor is at least this fraction of the genesis price (the auction never pays more than 1000 times the launch price).
pub const MAX_GENESIS_OVER_FLOOR: u64 = 1_000;
/// Most USDC one fill may take, and the largest first buyback target `init_ds` accepts, in whole USDC.
pub const MAX_LOT_USDC: u64 = 100_000;
pub const MAX_BUYBACK_TARGET_USDC: u64 = 1_000_000;
/// Of the stakers' USDC that waited (nobody staked, or rounding), at most a tenth goes out at each round start.
pub const CARRY_RELEASE_DIV: u128 = 10;
/// After each completed buyback round the next target is 98% of the last.
pub const BUYBACK_TARGET_DECAY_BPS: u64 = 9_800;

/// How the protocol fee is shared, in basis points of the fee. The four parts
/// must add up to 10 000; the treasury also takes any rounding remainder, so
/// the parts of every fee add up to the fee exactly.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace, PartialEq, Eq, Debug)]
pub struct FeeSplitBps {
    /// $DS stakers, paid in USDC pro rata to stake
    pub stakers: u16,
    /// players who lost money in the round, paid in $DS
    pub rebate: u16,
    /// buys $DS in the auction and burns it
    pub buyback: u16,
    /// protocol treasury
    pub treasury: u16,
}

impl FeeSplitBps {
    pub fn is_valid(&self) -> bool {
        self.stakers as u64 + self.rebate as u64 + self.buyback as u64 + self.treasury as u64 == BPS
    }
}

/// The descending price auction that turns the buyback and rebate pools into $DS.
/// Prices are in $DS base units per whole USDC: a higher price means the program
/// asks for more $DS for each USDC it pays out.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace, PartialEq, Eq, Debug)]
pub struct Auction {
    /// the price the next descent restarts from, divided by 1.5: the last fill's price,
    /// doubled when that fill came within `QUICK_REFILL_SECS` of the one before
    /// (the genesis price until the first fill)
    pub last_price: u64,
    /// when the current descent began: the last fill, or `init_ds`
    pub started_at: i64,
    /// lowest price the auction ever asks, so the most USDC paid per $DS
    pub floor_price: u64,
    /// seconds from the start price down to the floor
    pub duration: i64,
    /// most USDC a single fill may take
    pub lot: u64,
    /// least USDC a single fill must take, unless it takes all that is on offer
    pub min_fill: u64,
}

/// Running totals since initialization, so anyone can check the books from one account.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace, PartialEq, Eq, Debug)]
pub struct Totals {
    pub rounds_started: u64,
    pub rounds_settled: u64,
    pub rounds_refunded: u64,
    /// gross stakes of every round that started
    pub staked: u64,
    pub fees: u64,
    pub to_stakers: u64,
    pub to_rebate: u64,
    pub to_buyback: u64,
    pub to_treasury: u64,
    /// USDC paid out of the buyback pool by the auction
    pub buyback_spent: u64,
    /// USDC paid out of the rebate pool by the auction
    pub rebate_spent: u64,
    pub ds_burned: u64,
    /// $DS the rebate pool bought into the reserve
    pub ds_to_reserve: u64,
    /// USDC of rebates credited to players who lost money
    pub rebates_credited: u64,
    /// USDC of rebate credits turned into $DS
    pub rebates_claimed: u64,
    /// $DS paid out of the reserve for those credits
    pub ds_rebated: u64,
    pub treasury_swept: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    /// set by `propose_admin`, takes over on `accept_admin`
    pub pending_admin: Pubkey,
    /// the game server's key
    pub authority: Pubkey,
    /// the stake token (USDC)
    pub mint: Pubkey,
    pub custody: Pubkey,
    /// $DS, recorded once by `init_ds`, with the token program that owns it
    pub ds_mint: Pubkey,
    pub ds_custody: Pubkey,
    pub ds_token_program: Pubkey,
    /// [casual Hider, casual Seeker, pro Hider, pro Seeker] in base units
    pub stakes: [u64; 4],
    pub fee_bps: u16,
    pub split: FeeSplitBps,
    pub decimals: u8,
    pub bump: u8,
    // USDC the program owes, all inside `custody` (vault balances and room pots aside)
    pub treasury: u64,
    pub staker_pool: u64,
    pub rebate_pool: u64,
    pub buyback_pool: u64,
    // the buyback rule
    /// USDC a buyback round spends: set once by `init_ds`, then only lowered by 2% per completed round
    pub buyback_target: u64,
    /// the target `init_ds` set; target n is this times 0.98^n, rounded down each time
    pub buyback_target_initial: u64,
    /// completed buyback rounds
    pub buybacks_done: u64,
    /// USDC left to spend in the open buyback round (0: none open)
    pub buyback_round_left: u64,
    // rebates and $DS inside `ds_custody` (vault $DS aside)
    /// $DS the rebate pool bought and nobody has claimed yet
    pub ds_reserve: u64,
    /// USDC the rebate pool paid for `ds_reserve`
    pub reserve_cost: u64,
    /// USDC of rebates credited to vaults and not yet turned into $DS
    pub rebate_credits: u64,
    pub ds_staked: u64,
    /// USDC per staked $DS base unit, scaled by `REWARD_SCALE`
    pub reward_per_ds: u128,
    /// stakers' USDC not yet in the accumulator (nobody staked, or rounding), scaled by
    /// `REWARD_SCALE`; at most a tenth of it goes out at each round start
    pub reward_carry: u128,
    pub auction: Auction,
    pub totals: Totals,
}

impl Config {
    pub fn stake_for(&self, tier: u8, slot: u8) -> u64 {
        let seeker = (slot as usize) < SEEKER_SEATS;
        self.stakes[tier as usize * 2 + seeker as usize]
    }

    pub fn usdc_unit(&self) -> u64 {
        10u64.pow(self.decimals as u32)
    }

    pub fn ds_ready(&self) -> bool {
        self.ds_mint != Pubkey::default()
    }
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub owner: Pubkey,
    /// USDC free to withdraw, stake in a room or spend
    pub balance: u64,
    /// USDC in rooms right now
    pub locked: u64,
    /// the game server may lock room stakes until then
    pub session_expires: i64,
    /// most USDC the game server may lock in a day
    pub daily_cap: u64,
    pub spent_day: i64,
    pub spent: u64,
    /// $DS free to withdraw or stake
    pub ds_balance: u64,
    pub ds_staked: u64,
    /// accumulator value at the last reward sync
    pub reward_index: u128,
    /// USDC staking rewards synced but not yet claimed
    pub rewards: u64,
    /// USDC of rebates owed to this vault, paid in $DS by `claim_rebate`
    pub rebate_credit: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace, PartialEq, Eq, Debug)]
pub struct Seat {
    pub owner: Pubkey,
    pub stake: u64,
}

impl Seat {
    pub fn is_empty(&self) -> bool {
        self.owner == Pubkey::default()
    }
}

#[account]
#[derive(InitSpace)]
pub struct Room {
    pub index: u8,
    /// 0 casual, 1 pro
    pub tier: u8,
    pub status: u8,
    pub bump: u8,
    pub round: u64,
    /// USDC in escrow for this round (net of the fee once live)
    pub pot: u64,
    /// fee taken when the round started
    pub fee: u64,
    /// the part of the fee owed to this round's losers, credited at settlement
    pub rebate: u64,
    /// when the round started; while the room is open, when its lobby began forming
    /// (the first seat taken in an empty room), which only emptying the room resets
    pub started_at: i64,
    /// last lock, unlock or start
    pub updated_at: i64,
    pub seats: [Seat; SEATS],
}

impl Room {
    pub fn reset(&mut self, round: u64) {
        self.round = round;
        self.status = STATUS_OPEN;
        self.pot = 0;
        self.fee = 0;
        self.rebate = 0;
        self.started_at = 0;
        self.seats = [Seat::default(); SEATS];
    }

    pub fn finish(&mut self) {
        self.status = STATUS_SETTLED;
        self.pot = 0;
    }

    pub fn is_full(&self) -> bool {
        self.seats.iter().all(|s| !s.is_empty())
    }
}

/// Tokens locked for one beneficiary, released linearly between `start` and
/// `end`, nothing before `cliff`. Nobody can revoke it or release it early.
#[account]
#[derive(InitSpace)]
pub struct Vesting {
    pub beneficiary: Pubkey,
    pub mint: Pubkey,
    pub funder: Pubkey,
    pub id: u64,
    pub total: u64,
    pub claimed: u64,
    pub start: i64,
    pub cliff: i64,
    pub end: i64,
    pub bump: u8,
}
