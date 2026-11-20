import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FEE_SPLIT_BPS,
  PROTOCOL_FEE_BPS,
  PUBLISHED,
  ROOM_ECONOMICS,
  SURVIVED,
  calculateLiveMatchEarnings,
  calculateProtocolRevenueSplit,
  payoutsFor,
  playerBreakdown,
  settleDarkSeekMatch,
} from '../src/index.js';

const seekers = (a: number, b: number) => [
  { id: 'pro', name: 'Pro', kills: a },
  { id: 'noob', name: 'Noob', kills: b },
];
const hiders = (alive: number) => Array.from({ length: 8 }, (_, i) => ({ id: `h${i}`, name: `H${i}`, survived: i < alive }));
const sum = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x, 0) * 1e4) / 1e4;

test('Hiders win: survivors split both Seeker stakes evenly, Seekers keep loot per catch', () => {
  // casual: Hider 0.50 (net 0.45), Seeker 1.50 (net 1.35); 3 catches by pro, 1 by noob, 4 survivors
  const r = settleDarkSeekMatch('CASUAL', seekers(3, 1), hiders(4));
  assert.equal(r.seekersWon, false);
  const [pro, noob] = r.seekerResults;
  assert.equal(pro.stakeReturnedUsdc, 0);
  assert.equal(pro.lootEarnedUsdc, 1.35);
  assert.equal(noob.lootEarnedUsdc, 0.45);
  assert.ok(pro.totalPayoutUsdc > noob.totalPayoutUsdc);
  const survivor = r.hiderResults.find((h) => h.survived)!;
  assert.equal(survivor.survivalShareUsdc, 0.45);
  assert.equal(survivor.forfeitedSeekerBonusUsdc, 0.675); // (1.35 x 2) / 4
  const caught = r.hiderResults.find((h) => !h.survived)!;
  assert.equal(caught.totalPayoutUsdc, 0);
  // nothing is created or lost: payouts equal the 90% net pool
  assert.equal(sum([...r.seekerResults, ...r.hiderResults].map((x) => x.totalPayoutUsdc)), 6.3);
});

test('Seekers win only when every Hider is caught: stake back plus loot per own catch', () => {
  const r = settleDarkSeekMatch('PRO', seekers(6, 2), hiders(0));
  assert.equal(r.seekersWon, true);
  const [pro, noob] = r.seekerResults;
  assert.equal(pro.stakeReturnedUsdc, 6.75);
  assert.equal(pro.lootEarnedUsdc, 13.5);
  assert.equal(noob.lootEarnedUsdc, 4.5);
  assert.equal(pro.totalPayoutUsdc, 20.25);
  assert.ok(r.hiderResults.every((h) => h.totalPayoutUsdc === 0));
  assert.equal(sum([...r.seekerResults, ...r.hiderResults].map((x) => x.totalPayoutUsdc)), 31.5);
});

test('declared catches can never pay more than the Hider stakes actually lost', () => {
  const r = settleDarkSeekMatch('CASUAL', seekers(5, 5), hiders(5)); // only 3 Hiders were caught
  assert.equal(sum(r.seekerResults.map((x) => x.lootEarnedUsdc)), 1.35);
});

test('live estimate follows the same rules', () => {
  const hider = calculateLiveMatchEarnings({ tier: 'CASUAL', role: 'HIDER', alive: true, kills: 0, aliveHidersCount: 2 });
  assert.equal(hider.estimatedUsdc, 0.45 + 1.35);
  const seeker = calculateLiveMatchEarnings({ tier: 'CASUAL', role: 'SEEKER', alive: true, kills: 2, aliveHidersCount: 3 });
  assert.equal(seeker.estimatedUsdc, 0.9);
  assert.equal(seeker.winning, false);
});

test('the 10% fee: 10% to stakers, 20% to loser rebates, 20% to buyback and burn, 50% to the treasury, adding up exactly', () => {
  assert.equal(PROTOCOL_FEE_BPS, 1000);
  assert.equal(FEE_SPLIT_BPS.stakers + FEE_SPLIT_BPS.loserRebate + FEE_SPLIT_BPS.buybackBurn + FEE_SPLIT_BPS.treasury, 10_000);
  for (const gross of [0.5, 1.5, 2.5, 7.5, ROOM_ECONOMICS.CASUAL.totalGrossUsdc, ROOM_ECONOMICS.PRO.totalGrossUsdc, 123.4567]) {
    const s = calculateProtocolRevenueSplit(gross);
    assert.ok(Math.abs(s.totalRevenueUsdc - gross * 0.1) < 1e-4, `fee of ${gross}`);
    const parts = s.stakingPoolUsdc + s.losingPlayersDsValueUsdc + s.buybackBurnUsdc + s.treasuryUsdc;
    assert.ok(Math.abs(parts - s.totalRevenueUsdc) < 1e-9, `parts add up for ${gross}`);
    assert.ok(Math.abs(s.buybackBurnUsdc - s.totalRevenueUsdc * 0.2) < 1e-4, 'buyback is 20% of the fee');
    assert.ok(Math.abs(s.buybackBurnUsdc - gross * 0.02) < 1e-4, 'which is 2% of every stake');
  }
  const pro = calculateProtocolRevenueSplit(ROOM_ECONOMICS.PRO.totalGrossUsdc);
  assert.deepEqual(pro, { totalRevenueUsdc: 3.5, stakingPoolUsdc: 0.35, losingPlayersDsValueUsdc: 0.7, buybackBurnUsdc: 0.7, treasuryUsdc: 1.75 });
  const casual = calculateProtocolRevenueSplit(ROOM_ECONOMICS.CASUAL.totalGrossUsdc);
  assert.deepEqual(casual, { totalRevenueUsdc: 0.7, stakingPoolUsdc: 0.07, losingPlayersDsValueUsdc: 0.14, buybackBurnUsdc: 0.14, treasuryUsdc: 0.35 });
});

test('players who lost money share the rebate equally, as credit paid in $DS', () => {
  // casual rebate 0.14 USDC; 4 caught Hiders + 2 Seekers below their stake
  const r = settleDarkSeekMatch('CASUAL', seekers(3, 1), hiders(4));
  const losers = [...r.seekerResults, ...r.hiderResults].filter((x) => x.netPnlUsdc < 0);
  assert.equal(losers.length, 6);
  assert.ok(losers.every((x) => x.rebateUsdc === 0.023333));
  assert.ok(r.hiderResults.filter((h) => h.survived).every((h) => h.rebateUsdc === 0));
  assert.equal(playerBreakdown(r, 'HIDER', 'h7').rebateUsdc, 0.023333);
  assert.equal(playerBreakdown(r, 'SEEKER', 'pro').lootUsdc, 1.35);
});

test('the decimal rules and the program rules agree on every outcome of both tiers', () => {
  const stakes = [...PUBLISHED.stakes];
  for (const tier of ['CASUAL', 'PRO'] as const) {
    const t = tier === 'CASUAL' ? 0 : 1;
    for (let code = 0; code < 3 ** 8; code++) {
      const outcomes: number[] = [];
      let c = code;
      for (let i = 0; i < 8; i++) {
        outcomes.push([SURVIVED, 0, 1][c % 3]);
        c = Math.floor(c / 3);
      }
      const chain = payoutsFor(stakes, PUBLISHED.feeBps, t, outcomes).map((x) => Number(x) / 1e6);
      const caughtBy = (s: number) => outcomes.filter((o) => o === s).length;
      const r = settleDarkSeekMatch(
        tier,
        [
          { id: 's0', name: 'S0', kills: caughtBy(0) },
          { id: 's1', name: 'S1', kills: caughtBy(1) },
        ],
        outcomes.map((o, i) => ({ id: `h${i}`, name: `H${i}`, survived: o === SURVIVED })),
      );
      const decimal = [...r.seekerResults.map((x) => x.totalPayoutUsdc), ...r.hiderResults.map((x) => x.totalPayoutUsdc)];
      decimal.forEach((d, slot) => assert.ok(Math.abs(d - chain[slot]) < 1e-6, `${tier} ${outcomes.join(',')} slot ${slot}: ${d} vs ${chain[slot]}`));
    }
  }
});
