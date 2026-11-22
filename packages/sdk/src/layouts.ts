// Byte layouts of the program's accounts, events and instruction arguments,
// written from programs/darkseek-vault/src and checked against the IDL in tests.

import type { Fields, Ty } from './codec.js';

const SEATS = 10;
const HIDER_SEATS = 8;

export const FEE_SPLIT: Ty = {
  struct: [
    ['stakers', 'u16'],
    ['rebate', 'u16'],
    ['buyback', 'u16'],
    ['treasury', 'u16'],
  ],
};

export const AUCTION: Ty = {
  struct: [
    ['lastPrice', 'u64'],
    ['startedAt', 'i64'],
    ['floorPrice', 'u64'],
    ['duration', 'i64'],
    ['lot', 'u64'],
    ['minFill', 'u64'],
  ],
};

export const TOTALS: Ty = {
  struct: [
    ['roundsStarted', 'u64'],
    ['roundsSettled', 'u64'],
    ['roundsRefunded', 'u64'],
    ['staked', 'u64'],
    ['fees', 'u64'],
    ['toStakers', 'u64'],
    ['toRebate', 'u64'],
    ['toBuyback', 'u64'],
    ['toTreasury', 'u64'],
    ['buybackSpent', 'u64'],
    ['rebateSpent', 'u64'],
    ['dsBurned', 'u64'],
    ['dsToReserve', 'u64'],
    ['rebatesCredited', 'u64'],
    ['rebatesClaimed', 'u64'],
    ['dsRebated', 'u64'],
    ['treasurySwept', 'u64'],
  ],
};

export const SEAT: Ty = {
  struct: [
    ['owner', 'pubkey'],
    ['stake', 'u64'],
  ],
};

export const ACCOUNT_LAYOUTS = {
  Config: [
    ['admin', 'pubkey'],
    ['pendingAdmin', 'pubkey'],
    ['authority', 'pubkey'],
    ['mint', 'pubkey'],
    ['custody', 'pubkey'],
    ['dsMint', 'pubkey'],
    ['dsCustody', 'pubkey'],
    ['dsTokenProgram', 'pubkey'],
    ['stakes', { array: ['u64', 4] }],
    ['feeBps', 'u16'],
    ['split', FEE_SPLIT],
    ['decimals', 'u8'],
    ['bump', 'u8'],
    ['treasury', 'u64'],
    ['stakerPool', 'u64'],
    ['rebatePool', 'u64'],
    ['buybackPool', 'u64'],
    ['buybackTarget', 'u64'],
    ['buybackTargetInitial', 'u64'],
    ['buybacksDone', 'u64'],
    ['buybackRoundLeft', 'u64'],
    ['dsReserve', 'u64'],
    ['reserveCost', 'u64'],
    ['rebateCredits', 'u64'],
    ['dsStaked', 'u64'],
    ['rewardPerDs', 'u128'],
    ['rewardCarry', 'u128'],
    ['auction', AUCTION],
    ['totals', TOTALS],
  ],
  Vault: [
    ['owner', 'pubkey'],
    ['balance', 'u64'],
    ['locked', 'u64'],
    ['sessionExpires', 'i64'],
    ['dailyCap', 'u64'],
    ['spentDay', 'i64'],
    ['spent', 'u64'],
    ['dsBalance', 'u64'],
    ['dsStaked', 'u64'],
    ['rewardIndex', 'u128'],
    ['rewards', 'u64'],
    ['rebateCredit', 'u64'],
    ['bump', 'u8'],
  ],
  Room: [
    ['index', 'u8'],
    ['tier', 'u8'],
    ['status', 'u8'],
    ['bump', 'u8'],
    ['round', 'u64'],
    ['pot', 'u64'],
    ['fee', 'u64'],
    ['rebate', 'u64'],
    ['startedAt', 'i64'],
    ['updatedAt', 'i64'],
    ['seats', { array: [SEAT, SEATS] }],
  ],
  Vesting: [
    ['beneficiary', 'pubkey'],
    ['mint', 'pubkey'],
    ['funder', 'pubkey'],
    ['id', 'u64'],
    ['total', 'u64'],
    ['claimed', 'u64'],
    ['start', 'i64'],
    ['cliff', 'i64'],
    ['end', 'i64'],
    ['bump', 'u8'],
  ],
} as const satisfies Record<string, Fields>;

export const EVENT_LAYOUTS = {
  ConfigInitialized: [
    ['admin', 'pubkey'],
    ['authority', 'pubkey'],
    ['mint', 'pubkey'],
    ['stakes', { array: ['u64', 4] }],
    ['feeBps', 'u16'],
    ['split', FEE_SPLIT],
  ],
  AuthoritySet: [
    ['previous', 'pubkey'],
    ['authority', 'pubkey'],
  ],
  AdminProposed: [
    ['admin', 'pubkey'],
    ['pendingAdmin', 'pubkey'],
  ],
  AdminAccepted: [
    ['previous', 'pubkey'],
    ['admin', 'pubkey'],
  ],
  RoomCreated: [
    ['room', 'u8'],
    ['tier', 'u8'],
  ],
  DsConfigured: [
    ['dsMint', 'pubkey'],
    ['dsTokenProgram', 'pubkey'],
    ['buybackTarget', 'u64'],
    ['genesisPrice', 'u64'],
    ['floorPrice', 'u64'],
    ['duration', 'i64'],
    ['lot', 'u64'],
    ['minFill', 'u64'],
  ],
  VaultOpened: [
    ['owner', 'pubkey'],
    ['payer', 'pubkey'],
  ],
  SessionSet: [
    ['owner', 'pubkey'],
    ['dailyCap', 'u64'],
    ['expiresAt', 'i64'],
  ],
  Deposited: [
    ['owner', 'pubkey'],
    ['depositor', 'pubkey'],
    ['amount', 'u64'],
  ],
  Withdrawn: [
    ['owner', 'pubkey'],
    ['to', 'pubkey'],
    ['amount', 'u64'],
  ],
  Charged: [
    ['owner', 'pubkey'],
    ['amount', 'u64'],
  ],
  Paid: [
    ['from', 'pubkey'],
    ['to', 'pubkey'],
    ['amount', 'u64'],
  ],
  StakeLocked: [
    ['room', 'u8'],
    ['round', 'u64'],
    ['slot', 'u8'],
    ['owner', 'pubkey'],
    ['stake', 'u64'],
  ],
  StakeUnlocked: [
    ['room', 'u8'],
    ['round', 'u64'],
    ['slot', 'u8'],
    ['owner', 'pubkey'],
    ['stake', 'u64'],
  ],
  SeatLeft: [
    ['room', 'u8'],
    ['round', 'u64'],
    ['slot', 'u8'],
    ['owner', 'pubkey'],
    ['stake', 'u64'],
  ],
  RoundStarted: [
    ['room', 'u8'],
    ['round', 'u64'],
    ['tier', 'u8'],
    ['owners', { array: ['pubkey', SEATS] }],
    ['gross', 'u64'],
    ['fee', 'u64'],
    ['toStakers', 'u64'],
    ['toRebate', 'u64'],
    ['toBuyback', 'u64'],
    ['toTreasury', 'u64'],
    ['pot', 'u64'],
  ],
  RoundSettled: [
    ['room', 'u8'],
    ['round', 'u64'],
    ['seekersWon', 'bool'],
    ['outcomes', { array: ['u8', HIDER_SEATS] }],
    ['payouts', { array: ['u64', SEATS] }],
    ['losers', 'u16'],
    ['rebateUsdc', 'u64'],
    ['dust', 'u64'],
  ],
  RoundRefunded: [
    ['room', 'u8'],
    ['round', 'u64'],
    ['afterStart', 'bool'],
    ['stale', 'bool'],
    ['refunds', { array: ['u64', SEATS] }],
    ['rebateUsdc', 'u64'],
  ],
  TreasurySwept: [
    ['to', 'pubkey'],
    ['amount', 'u64'],
    ['treasury', 'u64'],
  ],
  DsDeposited: [
    ['owner', 'pubkey'],
    ['depositor', 'pubkey'],
    ['amount', 'u64'],
  ],
  DsWithdrawn: [
    ['owner', 'pubkey'],
    ['to', 'pubkey'],
    ['amount', 'u64'],
  ],
  DsStaked: [
    ['owner', 'pubkey'],
    ['amount', 'u64'],
    ['staked', 'u64'],
    ['totalStaked', 'u64'],
  ],
  DsUnstaked: [
    ['owner', 'pubkey'],
    ['amount', 'u64'],
    ['staked', 'u64'],
    ['totalStaked', 'u64'],
  ],
  RewardsClaimed: [
    ['owner', 'pubkey'],
    ['amount', 'u64'],
  ],
  Buyback: [
    ['seller', 'pubkey'],
    ['price', 'u64'],
    ['usdc', 'u64'],
    ['ds', 'u64'],
    ['dsBurned', 'u64'],
    ['dsToReserve', 'u64'],
    ['fromBuyback', 'u64'],
    ['fromRebate', 'u64'],
    ['buybackPool', 'u64'],
    ['rebatePool', 'u64'],
    ['buybackTarget', 'u64'],
    ['buybacksDone', 'u64'],
    ['buybackRoundLeft', 'u64'],
  ],
  RebateClaimed: [
    ['owner', 'pubkey'],
    ['usdc', 'u64'],
    ['ds', 'u64'],
    ['creditLeft', 'u64'],
  ],
  VestingCreated: [
    ['vesting', 'pubkey'],
    ['beneficiary', 'pubkey'],
    ['mint', 'pubkey'],
    ['funder', 'pubkey'],
    ['id', 'u64'],
    ['total', 'u64'],
    ['start', 'i64'],
    ['cliff', 'i64'],
    ['end', 'i64'],
  ],
  VestingClaimed: [
    ['vesting', 'pubkey'],
    ['beneficiary', 'pubkey'],
    ['amount', 'u64'],
    ['claimed', 'u64'],
  ],
} as const satisfies Record<string, Fields>;

/** Instruction arguments, in order, keyed by the Rust handler name. */
export const INSTRUCTION_ARGS = {
  initialize: [
    [
      'args',
      {
        struct: [
          ['authority', 'pubkey'],
          ['stakes', { array: ['u64', 4] }],
          ['feeBps', 'u16'],
          ['split', FEE_SPLIT],
        ],
      },
    ],
  ],
  set_authority: [['authority', 'pubkey']],
  propose_admin: [['pendingAdmin', 'pubkey']],
  accept_admin: [],
  init_room: [
    ['index', 'u8'],
    ['tier', 'u8'],
  ],
  init_ds: [
    [
      'args',
      {
        struct: [
          ['genesisPrice', 'u64'],
          ['floorPrice', 'u64'],
          ['duration', 'i64'],
          ['lot', 'u64'],
          ['minFill', 'u64'],
          ['buybackTarget', 'u64'],
        ],
      },
    ],
  ],
  sweep_treasury: [['amount', 'u64']],
  open_vault: [],
  set_session: [
    ['dailyCap', 'u64'],
    ['expiresAt', 'i64'],
  ],
  deposit: [['amount', 'u64']],
  withdraw: [['amount', 'u64']],
  charge: [['amount', 'u64']],
  pay: [['amount', 'u64']],
  lock_stake: [
    ['round', 'u64'],
    ['slot', 'u8'],
  ],
  unlock_stake: [
    ['round', 'u64'],
    ['slot', 'u8'],
  ],
  leave_seat: [
    ['round', 'u64'],
    ['slot', 'u8'],
  ],
  start_round: [['round', 'u64']],
  settle_round: [
    ['round', 'u64'],
    ['outcomes', { array: ['u8', HIDER_SEATS] }],
  ],
  cancel_round: [['round', 'u64']],
  abort_stale_round: [['round', 'u64']],
  deposit_ds: [['amount', 'u64']],
  withdraw_ds: [['amount', 'u64']],
  stake_ds: [['amount', 'u64']],
  unstake_ds: [['amount', 'u64']],
  claim_rewards: [],
  claim_rebate: [],
  sell_ds: [
    ['maxDs', 'u64'],
    ['minUsdc', 'u64'],
  ],
  create_vesting: [
    ['id', 'u64'],
    ['total', 'u64'],
    ['start', 'i64'],
    ['cliff', 'i64'],
    ['end', 'i64'],
  ],
  claim_vesting: [],
} as const satisfies Record<string, Fields>;

export type InstructionName = keyof typeof INSTRUCTION_ARGS;
export type EventName = keyof typeof EVENT_LAYOUTS;
export type AccountName = keyof typeof ACCOUNT_LAYOUTS;
