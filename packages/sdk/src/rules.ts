// The program's money rules in TypeScript, base unit for base unit
// (programs/darkseek-vault/src/rules.rs). Tests run both against the same
// numbers, and the validator tests compare them with what the chain did.

import {
  AUCTION_RESTART_BPS,
  BPS,
  BUYBACK_TARGET_DECAY_BPS,
  CARRY_RELEASE_DIV,
  HIDER_SEATS,
  MAX_AUCTION_SECS,
  MAX_BUYBACK_TARGET_USDC,
  MAX_GENESIS_OVER_FLOOR,
  MAX_LOT_USDC,
  MIN_AUCTION_SECS,
  REWARD_SCALE,
  SEATS,
  SEEKER_SEATS,
  SURVIVED,
} from './constants.js';
import type { AuctionState, FeeSplit } from './accounts.js';

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const U64_MAX = (1n << 64n) - 1n;

/** Fee on one stake, rounded down. */
export const feeOn = (stake: bigint, feeBps: number): bigint => (stake * BigInt(feeBps)) / BPS;

export interface FeeParts {
  stakers: bigint;
  rebate: bigint;
  buyback: bigint;
  treasury: bigint;
}

/**
 * The parts of a round's fee as the program takes them at the start: split four ways
 * once $DS is recorded, all of it to the treasury before (v0.4.0 and later).
 */
export function feeParts(fee: bigint, split: FeeSplit, dsReady: boolean): FeeParts {
  return dsReady ? splitFee(fee, split) : { stakers: 0n, rebate: 0n, buyback: 0n, treasury: fee };
}

/** The four parts of a fee; the treasury takes the rounding remainder so they add up exactly. */
export function splitFee(fee: bigint, split: FeeSplit): FeeParts {
  const part = (bps: number) => (fee * BigInt(bps)) / BPS;
  const stakers = part(split.stakers);
  const rebate = part(split.rebate);
  const buyback = part(split.buyback);
  return { stakers, rebate, buyback, treasury: fee - stakers - rebate - buyback };
}

/** Stake of a slot (0 and 1 Seekers, 2 to 9 Hiders) in a tier, from config.stakes. */
export const stakeFor = (stakes: readonly bigint[], tier: number, slot: number): bigint => stakes[tier * 2 + (slot < SEEKER_SEATS ? 1 : 0)];

/** Gross stake of every seat of a full room. */
export const seatStakes = (stakes: readonly bigint[], tier: number): bigint[] => Array.from({ length: SEATS }, (_, slot) => stakeFor(stakes, tier, slot));

/** Fee of a full room: taken seat by seat. */
export const roomFee = (stakes: readonly bigint[], tier: number, feeBps: number): bigint => seatStakes(stakes, tier).reduce((s, x) => s + feeOn(x, feeBps), 0n);

/**
 * What each slot is owed at the end of a round. `outcomes[i]` is Hider slot 2 + i:
 * SURVIVED, or the Seeker slot (0 or 1) that caught it.
 */
export function payoutsFor(stakes: readonly bigint[], feeBps: number, tier: number, outcomes: readonly number[]): bigint[] {
  if (outcomes.length !== HIDER_SEATS) throw new Error(`expected ${HIDER_SEATS} outcomes`);
  const hiderStake = stakes[tier * 2];
  const seekerStake = stakes[tier * 2 + 1];
  const netHider = hiderStake - feeOn(hiderStake, feeBps);
  const netSeeker = seekerStake - feeOn(seekerStake, feeBps);
  const catches = [0n, 0n];
  let survivors = 0n;
  for (const o of outcomes) {
    if (o === SURVIVED) survivors++;
    else if (o >= 0 && o < SEEKER_SEATS) catches[o]++;
    else throw new Error(`bad outcome ${o}`);
  }
  const seekersWon = survivors === 0n;
  const out: bigint[] = new Array(SEATS).fill(0n);
  for (let s = 0; s < SEEKER_SEATS; s++) out[s] = catches[s] * netHider + (seekersWon ? netSeeker : 0n);
  const bonus = seekersWon ? 0n : (netSeeker * BigInt(SEEKER_SEATS)) / survivors;
  outcomes.forEach((o, i) => {
    if (o === SURVIVED) out[SEEKER_SEATS + i] = netHider + bonus;
  });
  return out;
}

/** Bit `slot` set for every seat that ended below its stake. */
export function losersMask(stakes: readonly bigint[], payouts: readonly bigint[]): number {
  let mask = 0;
  for (let slot = 0; slot < SEATS; slot++) if (payouts[slot] < stakes[slot]) mask |= 1 << slot;
  return mask;
}

export const maskSlots = (mask: number): number[] => Array.from({ length: SEATS }, (_, s) => s).filter((s) => mask & (1 << s));

/** USDC of rebate credited to each losing seat: the round's rebate, split equally, rounded down. */
export const rebatePerLoser = (rebateUsdc: bigint, losers: number): bigint => (losers === 0 ? 0n : rebateUsdc / BigInt(losers));

/**
 * Turns up to `credit` USDC of rebate credit into $DS at the reserve's average
 * purchase cost, as far as the reserve reaches: [credit used, $DS paid].
 */
export function rebateClaim(credit: bigint, dsReserve: bigint, reserveCost: bigint): [bigint, bigint] {
  const usdc = min(credit, reserveCost);
  if (usdc === 0n) return [0n, 0n];
  return [usdc, (usdc * dsReserve) / reserveCost];
}

// ---------------------------------------------------------------------- staking

/**
 * Adds a round's USDC for stakers. With stakers, this round's amount goes out now and of
 * what waited (nobody staked, or rounding) at most a tenth, at least one unit (v0.4.0).
 */
export function accrueRewards(acc: bigint, carry: bigint, totalStaked: bigint, amount: bigint): { acc: bigint; carry: bigint } {
  const fresh = amount * REWARD_SCALE;
  if (totalStaked === 0n) return { acc, carry: carry + fresh };
  const release = (carry + CARRY_RELEASE_DIV - 1n) / CARRY_RELEASE_DIV;
  const pending = fresh + release;
  const inc = pending / totalStaked;
  return { acc: acc + inc, carry: carry - release + (pending - inc * totalStaked) };
}

/** The auction settings init_ds accepts (v0.4.0): see the program's ds_args_ok. */
export function dsArgsOk(a: { genesisPrice: bigint; floorPrice: bigint; duration: bigint; lot: bigint; minFill: bigint; buybackTarget: bigint }, usdcUnit: bigint): boolean {
  return (
    a.floorPrice > 0n &&
    a.genesisPrice >= a.floorPrice &&
    a.genesisPrice <= a.floorPrice * MAX_GENESIS_OVER_FLOOR &&
    a.duration >= MIN_AUCTION_SECS &&
    a.duration <= MAX_AUCTION_SECS &&
    a.minFill > 0n &&
    a.lot >= a.minFill &&
    a.lot <= usdcUnit * MAX_LOT_USDC &&
    a.buybackTarget > 0n &&
    a.buybackTarget <= usdcUnit * MAX_BUYBACK_TARGET_USDC
  );
}

/** What a fill at `price` leaves as the auction's reference: doubled when it came quickly after the one before. */
export const nextReferencePrice = (price: bigint, quick: boolean): bigint => (quick ? min(price * 2n, U64_MAX) : price);

export const earned = (staked: bigint, acc: bigint, index: bigint): bigint => (staked * (acc - index)) / REWARD_SCALE;

// ---------------------------------------------------------------------- buyback

/** What the buyback side may spend: an open round's budget, or exactly the target once the pool holds it; with a target of zero, the pool. */
export function buybackAvailable(pool: bigint, target: bigint, roundLeft: bigint): bigint {
  if (target === 0n) return pool;
  if (roundLeft > 0n) return min(roundLeft, pool);
  return pool >= target ? target : 0n;
}

/** The target after a completed round: 98% of the last, rounded down. */
export const nextBuybackTarget = (target: bigint): bigint => (target * BUYBACK_TARGET_DECAY_BPS) / BPS;

/** Target n: the initial target times 0.98^n, rounded down at each step. */
export function buybackTargetAfter(initial: bigint, rounds: bigint): bigint {
  let t = initial;
  for (let i = 0n; i < rounds && t > 0n; i++) t = nextBuybackTarget(t);
  return t;
}

// ---------------------------------------------------------------------- auction

/** The auction price at `now` (unix seconds): 1.5x the last fill, straight down to the floor over `duration`. */
export function auctionPrice(a: AuctionState, now: bigint): bigint {
  const start = max(min((a.lastPrice * AUCTION_RESTART_BPS) / BPS, U64_MAX), a.floorPrice);
  const elapsed = max(now - a.startedAt, 0n);
  if (a.duration <= 0n || elapsed >= a.duration) return a.floorPrice;
  return start - ((start - a.floorPrice) * elapsed) / a.duration;
}

/** Seconds until the auction asks `target` or less (0 if it already does; null if it never will). */
export function secondsUntilPrice(a: AuctionState, now: bigint, target: bigint): bigint | null {
  if (auctionPrice(a, now) <= target) return 0n;
  if (target < a.floorPrice) return null;
  const start = max(min((a.lastPrice * AUCTION_RESTART_BPS) / BPS, U64_MAX), a.floorPrice);
  // smallest t with start - (start - floor) * t / duration <= target
  const span = start - a.floorPrice;
  const t = ((start - target) * a.duration + span - 1n) / span;
  return max(a.startedAt + t - now, 0n);
}

export interface Fill {
  usdc: bigint;
  ds: bigint;
  dsBurned: bigint;
  dsToReserve: bigint;
  fromBuyback: bigint;
  fromRebate: bigint;
}

/** One fill: up to `maxDs` at `price`, paid from the buyback side's budget and the rebate pool in proportion, at most `lot`. */
export function auctionFill(price: bigint, maxDs: bigint, buyback: bigint, rebate: bigint, lot: bigint, usdcUnit: bigint): Fill | null {
  if (price === 0n) return null;
  const pools = buyback + rebate;
  const usdc = min(min(pools, lot), (maxDs * usdcUnit) / price);
  if (usdc === 0n) return null;
  const ds = (usdc * price + usdcUnit - 1n) / usdcUnit;
  const fromBuyback = (usdc * buyback) / pools;
  const dsBurned = (ds * fromBuyback) / usdc;
  return { usdc, ds, dsBurned, dsToReserve: ds - dsBurned, fromBuyback, fromRebate: usdc - fromBuyback };
}

/** USDC price of one whole $DS implied by an auction price. */
export const usdcPerDs = (price: bigint, dsUnit = 1_000_000n): number => (price === 0n ? Infinity : Number(dsUnit) / Number(price));

// ---------------------------------------------------------------------- vesting

export function vested(total: bigint, start: bigint, cliff: bigint, end: bigint, now: bigint): bigint {
  if (now < cliff || now <= start) return 0n;
  if (now >= end) return total;
  return (total * (now - start)) / (end - start);
}
