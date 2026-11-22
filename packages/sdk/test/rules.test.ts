// The same cases as the Rust unit tests in programs/darkseek-vault/src/rules.rs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PUBLISHED,
  REWARD_SCALE,
  SURVIVED,
  accrueRewards,
  auctionFill,
  auctionPrice,
  buybackAvailable,
  buybackTargetAfter,
  earned,
  losersMask,
  nextBuybackTarget,
  payoutsFor,
  rebateClaim,
  rebatePerLoser,
  roomFee,
  seatStakes,
  secondsUntilPrice,
  splitFee,
  vested,
  type AuctionState,
} from '../src/index.js';

const U = 1_000_000n;
const stakes = [...PUBLISHED.stakes];

test('the fee is 10% of every seat and splits 10/20/20/50 exactly', () => {
  assert.equal(roomFee(stakes, 0, 1000), 700_000n);
  assert.equal(roomFee(stakes, 1, 1000), 3_500_000n);
  assert.deepEqual(splitFee(700_000n, PUBLISHED.split), { stakers: 70_000n, rebate: 140_000n, buyback: 140_000n, treasury: 350_000n });
  assert.deepEqual(splitFee(3_500_000n, PUBLISHED.split), { stakers: 350_000n, rebate: 700_000n, buyback: 700_000n, treasury: 1_750_000n });
  for (const fee of [0n, 1n, 7n, 99n, 12_345n, 999_999_937n]) {
    const p = splitFee(fee, PUBLISHED.split);
    assert.equal(p.stakers + p.rebate + p.buyback + p.treasury, fee);
  }
});

test('payouts: Hiders win, survivors split both Seeker stakes; losers are the caught and the Seekers', () => {
  const p = payoutsFor(stakes, 1000, 0, [0, 0, 0, 1, SURVIVED, SURVIVED, SURVIVED, SURVIVED]);
  assert.deepEqual(p, [1_350_000n, 450_000n, 0n, 0n, 0n, 0n, 1_125_000n, 1_125_000n, 1_125_000n, 1_125_000n]);
  assert.equal(losersMask(seatStakes(stakes, 0), p), 0b11_1111);
});

test('payouts: Seekers win only when all eight are caught', () => {
  const p = payoutsFor(stakes, 1000, 1, [0, 0, 0, 0, 0, 0, 1, 1]);
  assert.equal(p[0], 6_750_000n + 6n * 2_250_000n);
  assert.equal(p[1], 6_750_000n + 2n * 2_250_000n);
  assert.equal(p.reduce((s, x) => s + x, 0n), 31_500_000n);
  assert.equal(losersMask(seatStakes(stakes, 1), p), 0b11_1111_1100);
  assert.throws(() => payoutsFor(stakes, 1000, 0, [2, SURVIVED, SURVIVED, SURVIVED, SURVIVED, SURVIVED, SURVIVED, SURVIVED]));
});

test('rebate: the round rebate split equally as USDC credit, paid in $DS at the reserve cost', () => {
  // casual rebate 0.14 USDC, six losers
  assert.equal(rebatePerLoser(140_000n, 6), 23_333n);
  assert.equal(rebatePerLoser(140_000n, 0), 0n);
  // the reserve bought 1 400 $DS for 14 USDC
  assert.deepEqual(rebateClaim(2n * U, 1_400n * U, 14n * U), [2n * U, 200n * U]);
  assert.deepEqual(rebateClaim(20n * U, 1_400n * U, 14n * U), [14n * U, 1_400n * U], 'only as far as the reserve reaches');
  assert.deepEqual(rebateClaim(3n, 1_000n, 7n), [3n, 428n]);
});

test('buyback: waits for the whole target, spends exactly it, then 98% of it', () => {
  const t = 150n * U;
  assert.equal(buybackAvailable(149n * U, t, 0n), 0n);
  assert.equal(buybackAvailable(400n * U, t, 0n), t);
  assert.equal(buybackAvailable(400n * U, t, 30n * U), 30n * U);
  assert.equal(buybackAvailable(7n, 0n, 0n), 7n);
  assert.deepEqual([0n, 1n, 2n, 3n, 4n].map((n) => buybackTargetAfter(t, n)), [150_000_000n, 147_000_000n, 144_060_000n, 141_178_800n, 138_355_224n]);
  assert.equal(nextBuybackTarget(138_355_224n), 135_588_119n);
  assert.equal(buybackTargetAfter(1n, 10n), 0n);
});

test('staking rewards are never overpaid', () => {
  let { acc, carry } = accrueRewards(0n, 0n, 0n, 70_000n);
  assert.equal(acc, 0n);
  assert.equal(carry, 70_000n * REWARD_SCALE);
  let paidIn = 70_000n;
  const stakers = [
    { staked: 3n, index: 0n, owed: 0n },
    { staked: 5n, index: 0n, owed: 0n },
    { staked: 11n, index: 0n, owed: 0n },
  ];
  for (let round = 0n; round < 300n; round++) {
    const total = stakers.reduce((s, x) => s + x.staked, 0n);
    ({ acc, carry } = accrueRewards(acc, carry, total, 70_001n));
    paidIn += 70_001n;
    const s = stakers[Number(round % 3n)];
    s.owed += earned(s.staked, acc, s.index);
    s.index = acc;
    s.staked += round % 4n;
  }
  const owed = stakers.reduce((t, s) => t + s.owed + earned(s.staked, acc, s.index), 0n);
  assert.ok(owed + carry / REWARD_SCALE <= paidIn);
  assert.ok(paidIn - owed - carry / REWARD_SCALE <= 900n);
});

test('auction: 1.5x the last fill, then legs that at most double the bid each, down to the floor at most', () => {
  const a: AuctionState = { lastPrice: 100n * U, startedAt: 1_000n, floorPrice: U, duration: 600n, lot: 1_000n * U, minFill: U };
  assert.equal(auctionPrice(a, 1_000n), 150n * U);
  assert.equal(auctionPrice(a, 900n), 150n * U);
  assert.equal(auctionPrice(a, 1_300n), 100n * U, 'halfway through the first leg: the last fill');
  assert.equal(auctionPrice(a, 1_600n), 50n * U, 'end of the first leg: twice the bid of the last fill');
  assert.equal(auctionPrice(a, 2_200n), 25n * U);
  assert.equal(auctionPrice(a, 1_000n + 7n * 600n), U, 'halved under the floor: it rests there');
  assert.equal(secondsUntilPrice(a, 1_000n, 150n * U), 0n);
  assert.equal(secondsUntilPrice(a, 1_000n, U / 2n), null);
  // the time to any price agrees with the curve, in every leg
  for (const target of [149n * U, 100n * U, 50n * U, 49n * U, 30n * U, 12n * U, 3n * U, U + 1n, U]) {
    for (const now of [1_000n, 1_123n, 1_700n]) {
      const t = secondsUntilPrice(a, now, target);
      assert.ok(t !== null, `reachable ${target}`);
      assert.ok(auctionPrice(a, now + t) <= target, `at ${now + t} the price is ${target} or less`);
      if (t > 0n) assert.ok(auctionPrice(a, now + t - 1n) > target, `not a second earlier (${target} from ${now})`);
    }
  }
});

test('auction with no floor: a day after the last fill the bid is at most 16 times it', () => {
  const a: AuctionState = { lastPrice: 300_000n * U, startedAt: 0n, floorPrice: 1n, duration: 21_600n, lot: 1_000n * U, minFill: U };
  assert.equal(auctionPrice(a, 4n * 21_600n), (300_000n * U) >> 4n);
  assert.equal(auctionPrice(a, 64n * 21_600n), 1n);
  assert.equal(auctionPrice(a, 10n ** 15n), 1n);
  const t = secondsUntilPrice(a, 0n, 1n)!;
  assert.ok(auctionPrice(a, t) === 1n && auctionPrice(a, t - 1n) > 1n);
});

test('auction fill: both pools in proportion, capped by the lot, rounded for the program', () => {
  const f = auctionFill(100n * U, 1_000n * U, 14n * U, 14n * U, 1_000n * U, U)!;
  assert.deepEqual(f, { usdc: 10n * U, ds: 1_000n * U, dsBurned: 500n * U, dsToReserve: 500n * U, fromBuyback: 5n * U, fromRebate: 5n * U });
  const g = auctionFill(100n * U, 10_000n * U, 30n * U, 10n * U, 20n * U, U)!;
  assert.equal(g.usdc, 20n * U);
  assert.equal(g.fromBuyback, 15n * U);
  assert.equal(auctionFill(100n * U, 1n, 14n * U, 0n, 1_000n * U, U), null);
});

test('vesting: nothing before the cliff, linear to the end', () => {
  assert.equal(vested(1_000n, 0n, 100n, 400n, 99n), 0n);
  assert.equal(vested(1_000n, 0n, 100n, 400n, 100n), 250n);
  assert.equal(vested(1_000n, 0n, 100n, 400n, 401n), 1_000n);
});
