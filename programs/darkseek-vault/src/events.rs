//! Events for every movement of value and every change of a privileged setting.
//! They are logged as `Program data:` lines (Anchor `emit!`); the indexer and the
//! SDK decode them. Amounts are base units of the token named in the field.

use crate::state::*;
use anchor_lang::prelude::*;

#[event]
pub struct ConfigInitialized {
    pub admin: Pubkey,
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub stakes: [u64; 4],
    pub fee_bps: u16,
    pub split: FeeSplitBps,
}

#[event]
pub struct AuthoritySet {
    pub previous: Pubkey,
    pub authority: Pubkey,
}

#[event]
pub struct AdminProposed {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
}

#[event]
pub struct AdminAccepted {
    pub previous: Pubkey,
    pub admin: Pubkey,
}

#[event]
pub struct RoomCreated {
    pub room: u8,
    pub tier: u8,
}

#[event]
pub struct DsConfigured {
    pub ds_mint: Pubkey,
    pub ds_token_program: Pubkey,
    /// USDC the first buyback round spends; each later round spends 98% of the one before
    pub buyback_target: u64,
    pub genesis_price: u64,
    pub floor_price: u64,
    pub duration: i64,
    pub lot: u64,
    pub min_fill: u64,
}

#[event]
pub struct VaultOpened {
    pub owner: Pubkey,
    pub payer: Pubkey,
}

#[event]
pub struct SessionSet {
    pub owner: Pubkey,
    pub daily_cap: u64,
    pub expires_at: i64,
}

#[event]
pub struct Deposited {
    pub owner: Pubkey,
    pub depositor: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Withdrawn {
    pub owner: Pubkey,
    pub to: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Charged {
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Paid {
    pub from: Pubkey,
    pub to: Pubkey,
    pub amount: u64,
}

#[event]
pub struct StakeLocked {
    pub room: u8,
    pub round: u64,
    pub slot: u8,
    pub owner: Pubkey,
    pub stake: u64,
}

#[event]
pub struct StakeUnlocked {
    pub room: u8,
    pub round: u64,
    pub slot: u8,
    pub owner: Pubkey,
    pub stake: u64,
}

/// The fee was taken and split when the round went live.
#[event]
pub struct RoundStarted {
    pub room: u8,
    pub round: u64,
    pub tier: u8,
    pub owners: [Pubkey; SEATS],
    pub gross: u64,
    pub fee: u64,
    pub to_stakers: u64,
    pub to_rebate: u64,
    pub to_buyback: u64,
    pub to_treasury: u64,
    pub pot: u64,
}

#[event]
pub struct RoundSettled {
    pub room: u8,
    pub round: u64,
    pub seekers_won: bool,
    pub outcomes: [u8; HIDER_SEATS],
    pub payouts: [u64; SEATS],
    /// bit `slot` set: that seat lost money this round
    pub losers: u16,
    /// USDC of rebate credited to each losing seat, paid in $DS by `claim_rebate`
    pub rebate_usdc: u64,
    /// rounding dust from the pot, added to the treasury
    pub dust: u64,
}

/// Stakes went back without a result: in full before the start, less the fee after it.
#[event]
pub struct RoundRefunded {
    pub room: u8,
    pub round: u64,
    pub after_start: bool,
    pub stale: bool,
    pub refunds: [u64; SEATS],
    /// after the start every seat lost the fee, so each is credited a share of the rebate
    pub rebate_usdc: u64,
}

#[event]
pub struct TreasurySwept {
    pub to: Pubkey,
    pub amount: u64,
    pub treasury: u64,
}

#[event]
pub struct DsDeposited {
    pub owner: Pubkey,
    pub depositor: Pubkey,
    pub amount: u64,
}

#[event]
pub struct DsWithdrawn {
    pub owner: Pubkey,
    pub to: Pubkey,
    pub amount: u64,
}

#[event]
pub struct DsStaked {
    pub owner: Pubkey,
    pub amount: u64,
    pub staked: u64,
    pub total_staked: u64,
}

#[event]
pub struct DsUnstaked {
    pub owner: Pubkey,
    pub amount: u64,
    pub staked: u64,
    pub total_staked: u64,
}

#[event]
pub struct RewardsClaimed {
    pub owner: Pubkey,
    pub amount: u64,
}

/// One fill of the $DS auction.
#[event]
pub struct Buyback {
    pub seller: Pubkey,
    /// $DS base units per whole USDC
    pub price: u64,
    pub usdc: u64,
    pub ds: u64,
    pub ds_burned: u64,
    pub ds_to_reserve: u64,
    pub from_buyback: u64,
    pub from_rebate: u64,
    pub buyback_pool: u64,
    pub rebate_pool: u64,
    /// the target after this fill: lower by 2% each time a round completes
    pub buyback_target: u64,
    pub buybacks_done: u64,
    /// USDC left in the open buyback round (0: none open)
    pub buyback_round_left: u64,
}

/// Rebate credit turned into $DS at the reserve's average purchase cost.
#[event]
pub struct RebateClaimed {
    pub owner: Pubkey,
    pub usdc: u64,
    pub ds: u64,
    pub credit_left: u64,
}

#[event]
pub struct VestingCreated {
    pub vesting: Pubkey,
    pub beneficiary: Pubkey,
    pub mint: Pubkey,
    pub funder: Pubkey,
    pub id: u64,
    pub total: u64,
    pub start: i64,
    pub cliff: i64,
    pub end: i64,
}

#[event]
pub struct VestingClaimed {
    pub vesting: Pubkey,
    pub beneficiary: Pubkey,
    pub amount: u64,
    pub claimed: u64,
}
