// Decoders for the program's accounts. Amounts are bigint base units.

import type { PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { decodeWithDiscriminator, discriminator, sizeOf } from './codec.js';
import { ACCOUNT_LAYOUTS, type AccountName } from './layouts.js';

export interface FeeSplit {
  stakers: number;
  rebate: number;
  buyback: number;
  treasury: number;
}

export interface AuctionState {
  /** $DS base units per whole USDC at the last fill (the genesis price before any) */
  lastPrice: bigint;
  startedAt: bigint;
  floorPrice: bigint;
  duration: bigint;
  lot: bigint;
  minFill: bigint;
}

export interface Totals {
  roundsStarted: bigint;
  roundsSettled: bigint;
  roundsRefunded: bigint;
  staked: bigint;
  fees: bigint;
  toStakers: bigint;
  toRebate: bigint;
  toBuyback: bigint;
  toTreasury: bigint;
  buybackSpent: bigint;
  rebateSpent: bigint;
  dsBurned: bigint;
  dsToReserve: bigint;
  rebatesCredited: bigint;
  rebatesClaimed: bigint;
  dsRebated: bigint;
  treasurySwept: bigint;
}

export interface ConfigAccount {
  admin: PublicKey;
  pendingAdmin: PublicKey;
  authority: PublicKey;
  mint: PublicKey;
  custody: PublicKey;
  dsMint: PublicKey;
  dsCustody: PublicKey;
  dsTokenProgram: PublicKey;
  stakes: bigint[];
  feeBps: number;
  split: FeeSplit;
  decimals: number;
  bump: number;
  treasury: bigint;
  stakerPool: bigint;
  rebatePool: bigint;
  buybackPool: bigint;
  /** USDC the next buyback round spends */
  buybackTarget: bigint;
  /** the target init_ds set: target n is this times 0.98^n, rounded down each time */
  buybackTargetInitial: bigint;
  buybacksDone: bigint;
  /** USDC left in the open buyback round (0: none open) */
  buybackRoundLeft: bigint;
  /** $DS the rebate pool bought, not yet claimed */
  dsReserve: bigint;
  /** USDC the rebate pool paid for dsReserve */
  reserveCost: bigint;
  /** USDC of rebates credited to vaults, not yet turned into $DS */
  rebateCredits: bigint;
  dsStaked: bigint;
  rewardPerDs: bigint;
  rewardCarry: bigint;
  auction: AuctionState;
  totals: Totals;
}

export interface VaultAccount {
  owner: PublicKey;
  balance: bigint;
  locked: bigint;
  sessionExpires: bigint;
  dailyCap: bigint;
  spentDay: bigint;
  spent: bigint;
  dsBalance: bigint;
  dsStaked: bigint;
  rewardIndex: bigint;
  rewards: bigint;
  /** USDC of rebates owed, paid in $DS by claim_rebate */
  rebateCredit: bigint;
  bump: number;
}

export interface Seat {
  owner: PublicKey;
  stake: bigint;
}

export interface RoomAccount {
  index: number;
  tier: number;
  status: number;
  bump: number;
  round: bigint;
  pot: bigint;
  fee: bigint;
  rebate: bigint;
  startedAt: bigint;
  updatedAt: bigint;
  seats: Seat[];
}

export interface VestingAccount {
  beneficiary: PublicKey;
  mint: PublicKey;
  funder: PublicKey;
  id: bigint;
  total: bigint;
  claimed: bigint;
  start: bigint;
  cliff: bigint;
  end: bigint;
  bump: number;
}

export const ACCOUNT_DISCRIMINATORS = Object.fromEntries(
  (Object.keys(ACCOUNT_LAYOUTS) as AccountName[]).map((n) => [n, discriminator('account', n)]),
) as Record<AccountName, ReturnType<typeof discriminator>>;

/** Data length of each account (discriminator included). */
export const ACCOUNT_SIZES = Object.fromEntries(
  (Object.keys(ACCOUNT_LAYOUTS) as AccountName[]).map((n) => [n, 8 + sizeOf({ struct: ACCOUNT_LAYOUTS[n] })]),
) as Record<AccountName, number>;

const decoder =
  <T>(name: AccountName) =>
  (data: Uint8Array): T =>
    decodeWithDiscriminator<T>(data, ACCOUNT_DISCRIMINATORS[name], ACCOUNT_LAYOUTS[name], `${name} account`);

export const decodeConfig = decoder<ConfigAccount>('Config');
export const decodeVault = decoder<VaultAccount>('Vault');
export const decodeRoom = decoder<RoomAccount>('Room');
export const decodeVesting = decoder<VestingAccount>('Vesting');

/** Which of the program's account types `data` is, if any. */
export function accountKind(data: Uint8Array): AccountName | null {
  const head = Buffer.from(data.buffer, data.byteOffset, Math.min(8, data.byteLength));
  for (const [name, disc] of Object.entries(ACCOUNT_DISCRIMINATORS)) if (head.equals(disc)) return name as AccountName;
  return null;
}
