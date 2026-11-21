// Paths that open only after time passes, run in LiteSVM so the clock can be
// moved: stale rounds anyone can unwind, session expiry and the daily cap,
// vesting, and the auction's descent to its floor.
//
// Run: scripts/build-program.sh && npx tsx --test tests/timelocks.test.ts

import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { LEAVE_AFTER_SECS, PUBLISHED, QUICK_REFILL_SECS, SURVIVED, STALE_AFTER_SECS, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ata, auctionPrice, buybackTargetAfter, decodeVesting, ixs, pda, seatStakes, splIxs, vested } from '../packages/sdk/src/index.js';
import { SvmChain } from './harness/chain.js';
import { DEFAULT_DS_ARGS, U, World, eventOf, expectError } from './harness/world.js';

const S = SURVIVED;
let chain: SvmChain;
let w: World;
let stranger: Keypair;
const keys = (ks: Keypair[]) => ks.map((k) => k.publicKey);

before(async () => {
  const admin = Keypair.generate();
  chain = new SvmChain(admin.publicKey);
  w = await new World(chain, admin).setup({ ds: { ...DEFAULT_DS_ARGS, duration: 3_600n } });
  stranger = Keypair.generate();
  await chain.airdrop(stranger.publicKey, 1);
});

test('the auction price falls in a straight line to the floor; each fill restarts it at 1.5x', async () => {
  const ten = await w.players(10, 50n * U);
  for (let r = 1n; r <= 3n; r++) await w.play(5, r, keys(ten), [0, 0, 1, 1, S, S, S, S]);
  const seller = await w.player(1n * U, { ds: 100_000n * U });
  const sell = (maxDs: bigint) => chain.send([ixs.sellDs(seller.publicKey, w.usdc, w.ds, maxDs, 0n)], [w.admin, seller]);

  let c = await w.config();
  await chain.advance(Number(c.auction.startedAt + 1_800n - (await chain.now())));
  const half = auctionPrice(c.auction, await chain.now());
  assert.equal(half, (150n * U + U) / 2n, 'halfway down from 150 to the floor of 1');
  const a = eventOf(await sell(10n * U), 'Buyback');
  assert.equal(a.price, half);

  c = await w.config();
  assert.equal(c.auction.lastPrice, half);
  assert.equal(auctionPrice(c.auction, await chain.now()), (half * 3n) / 2n, 'restarted at 1.5x the fill');
  await chain.advance(3_600 * 5);
  assert.equal(auctionPrice(c.auction, await chain.now()), U, 'resting at the floor');
  const b = eventOf(await sell(1_000n * U), 'Buyback');
  assert.equal(b.price, U);
  assert.equal(b.ds as bigint, b.usdc as bigint, 'at the floor one $DS buys one USDC, the most the program ever pays');
  // three pro rounds put 2.10 USDC in the buyback pool: one round of the 2 USDC target opened, and is now spent
  assert.equal(b.buybacksDone, 1n);
  assert.equal(b.buybackTarget, buybackTargetAfter(2n * U, 1n));
  await w.assertBooks('auction descent');
});

test('a lobby nobody touched for two hours: anyone returns every stake in full', async () => {
  const three = await w.players(3, 10n * U);
  await w.seat(1, 1n, keys(three));
  const abort = () => chain.send([ixs.abortStaleRound(stranger.publicKey, 1, 1n, keys(three))], [stranger]);
  await expectError(abort(), 'NotStale');
  await chain.advance(Number(STALE_AFTER_SECS) - 10);
  await expectError(abort(), 'NotStale');
  await chain.advance(10);
  const ev = eventOf(await abort(), 'RoundRefunded');
  assert.equal(ev.afterStart, false);
  assert.equal(ev.stale, true);
  for (const p of three) {
    const v = await w.vault(p.publicKey);
    assert.equal(v.balance, 10n * U);
    assert.equal(v.locked, 0n);
  }
  await w.assertBooks('stale lobby');
});

test('a live round nobody settled: anyone unwinds it after two hours, stakes back less the fee', async () => {
  const ten = await w.players(10, 20n * U);
  await w.seat(4, 1n, keys(ten));
  await w.start(4, 1n);
  const pools = await w.config();
  const abort = () => chain.send([ixs.abortStaleRound(stranger.publicKey, 4, 1n, keys(ten))], [stranger]);
  await chain.advance(Number(STALE_AFTER_SECS) - 1);
  await expectError(abort(), 'NotStale');
  await chain.advance(1);
  const ev = eventOf(await abort(), 'RoundRefunded');
  assert.equal(ev.afterStart, true);
  const stakes = seatStakes(PUBLISHED.stakes, 1);
  for (let slot = 0; slot < 10; slot++) assert.equal((await w.vault(ten[slot].publicKey)).balance, 20n * U - stakes[slot] / 10n);
  // the fee already split stays with its buckets
  const after = await w.config();
  assert.equal(after.buybackPool, pools.buybackPool);
  assert.equal(after.totals.roundsRefunded, 2n);
  await expectError(abort(), 'WrongRound');
  await w.assertBooks('stale round');
});

test('a session ends on time, and the daily cap resets the next day', async () => {
  const p = await w.player(10n * U, { cap: 3n * U / 2n });
  // ten minutes past the next midnight UTC, so the day boundaries below are known
  const t0 = ((await chain.now()) / 86_400n + 1n) * 86_400n + 600n;
  chain.setTime(t0);
  await chain.send([ixs.setSession(p.publicKey, 3n * U / 2n, t0 + 3_600n)], [w.admin, p]);
  await w.seat(2, 1n, [p.publicKey], 0); // a Seeker seat: 1.50, the whole cap
  await chain.send([ixs.unlockStake(w.authority.publicKey, 2, p.publicKey, 1n, 0)], [w.authority]);
  await expectError(w.seat(2, 1n, [p.publicKey], 0), 'OverDailyCap');
  await chain.advance(3_601);
  await expectError(w.seat(2, 1n, [p.publicKey], 0), 'NoSession');
  await chain.send([ixs.setSession(p.publicKey, 3n * U / 2n, t0 + 30n * 86_400n)], [w.admin, p]);
  await expectError(w.seat(2, 1n, [p.publicKey], 0), 'OverDailyCap');
  await chain.advance(86_400 - 600 - 3_601 + 1);
  await w.seat(2, 1n, [p.publicKey], 0);
  await chain.send([ixs.unlockStake(w.authority.publicKey, 2, p.publicKey, 1n, 0)], [w.authority]);
  await w.assertBooks('sessions');
});

test('vesting: nothing before the cliff, a straight line to the end, only ever to the beneficiary', async () => {
  const who = Keypair.generate();
  const total = 1_200_000n * U;
  const start = await chain.now();
  const day = 86_400n;
  const p = { id: 1n, total, start, cliff: start + 180n * day, end: start + 720n * day };
  await chain.send([ixs.createVesting(w.admin.publicKey, who.publicKey, w.ds, p)], [w.admin]);
  await expectError(chain.send([ixs.createVesting(w.admin.publicKey, who.publicKey, w.ds, p)], [w.admin]), /already in use/);
  const vesting = pda.vesting(w.ds, who.publicKey, 1n);
  const v = decodeVesting((await chain.account(vesting))!.data);
  assert.deepEqual([v.total, v.start, v.cliff, v.end], [total, p.start, p.cliff, p.end]);
  assert.equal(await w.tokens(pda.vestingTokens(vesting)), total);

  await chain.send([splIxs.createAtaIdempotent(w.admin.publicKey, who.publicKey, w.ds)], [w.admin]);
  const claim = () => chain.send([ixs.claimVesting(w.ds, who.publicKey, 1n)], [w.admin]);
  await chain.advance(Number(179n * day));
  await expectError(claim(), 'NothingToClaim');
  await chain.advance(Number(day));
  const first = eventOf(await claim(), 'VestingClaimed');
  assert.equal(first.amount, vested(total, p.start, p.cliff, p.end, await chain.now()));
  assert.equal(first.amount, total / 4n, 'a quarter at the cliff (180 of 720 days)');

  // the tokens can only go to the beneficiary's own account
  await chain.send([splIxs.createAtaIdempotent(w.admin.publicKey, w.admin.publicKey, w.ds)], [w.admin]);
  const redirected = ixs.claimVesting(w.ds, who.publicKey, 1n, TOKEN_PROGRAM_ID, ata(w.admin.publicKey, w.ds));
  await chain.advance(Number(30n * day));
  await expectError(chain.send([redirected], [w.admin]), /ConstraintTokenOwner|ConstraintOwner/);

  await chain.advance(Number(600n * day));
  await claim();
  assert.equal(await w.tokens(ata(who.publicKey, w.ds)), total);
  assert.equal(await w.tokens(pda.vestingTokens(vesting)), 0n);
  await expectError(claim(), 'NothingToClaim');
});

test('a lock works the same for a Token 2022 token, like a pump.fun mint with metadata', async () => {
  const mint = Keypair.generate();
  assert.ok((await w.createPumpLikeMint(mint, 'token-2022')).equals(TOKEN_2022_PROGRAM_ID));
  const who = Keypair.generate();
  const start = await chain.now();
  const p = { id: 7n, total: 30_000_000n * U, start, cliff: start + 3_600n, end: start + 4n * 3_600n };
  await chain.send([ixs.createVesting(w.admin.publicKey, who.publicKey, mint.publicKey, p, TOKEN_2022_PROGRAM_ID)], [w.admin]);
  await chain.send([splIxs.createAtaIdempotent(w.admin.publicKey, who.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID)], [w.admin]);
  const claim = () => chain.send([ixs.claimVesting(mint.publicKey, who.publicKey, 7n, TOKEN_2022_PROGRAM_ID)], [w.admin]);
  await expectError(claim(), 'NothingToClaim');
  await chain.advance(2 * 3_600);
  assert.equal(eventOf(await claim(), 'VestingClaimed').amount, p.total / 2n);
  await chain.advance(3 * 3_600);
  await claim();
  assert.equal(await w.tokens(ata(who.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID)), p.total);
});

test('a seated player leaves a lobby on their own after 30 minutes, whatever the game server does (v0.4.0)', async () => {
  const [p, q] = await w.players(2, 10n * U);
  await w.seat(3, 1n, [p.publicKey], 2);
  const leave = (who: Keypair, slot: number) => chain.send([ixs.leaveSeat(who.publicKey, 3, 1n, slot)], [w.admin, who]);
  await expectError(leave(p, 2), 'TooEarly');
  // the game server keeps locking and unlocking another seat: the lobby's clock does not restart
  await chain.advance(LEAVE_AFTER_SECS - 120);
  await w.seat(3, 1n, [q.publicKey], 3);
  await chain.send([ixs.unlockStake(w.authority.publicKey, 3, q.publicKey, 1n, 3)], [w.authority]);
  await expectError(leave(p, 2), 'TooEarly');
  await chain.advance(121);
  // nobody leaves a seat that is not theirs
  await expectError(leave(q, 2), 'BadSlot');
  const before = await w.vault(p.publicKey);
  const left = eventOf(await leave(p, 2), 'SeatLeft');
  assert.equal(left.stake, U / 2n, 'the whole casual Hider stake');
  const after = await w.vault(p.publicKey);
  assert.equal(after.balance, before.balance + U / 2n);
  assert.equal(after.locked, before.locked - U / 2n);
  assert.ok((await w.room(3)).seats.every((s) => s.owner.equals(PublicKey.default)));
  await w.assertBooks('leave a lobby');
});

test('a fill right after another restarts the price at 3 times, not 1.5 (v0.4.0)', async () => {
  const ten = await w.players(10, 50n * U);
  await w.play(6, 1n, keys(ten), [S, S, S, S, S, S, S, S]); // a pro round: 0.70 USDC into the rebate pool
  const seller = await w.player(1n * U, { ds: 1_000n * U });
  const sell = (maxDs: bigint) => chain.send([ixs.sellDs(seller.publicKey, w.usdc, w.ds, maxDs, 0n)], [w.admin, seller]);
  // the last fill was hours ago: an ordinary restart at 1.5 times
  await chain.advance(QUICK_REFILL_SECS + 1);
  const a = eventOf(await sell(U / 2n), 'Buyback');
  let c = await w.config();
  assert.equal(c.auction.lastPrice, a.price);
  // a second fill within ten minutes: the next descent starts at 3 times its price
  await chain.advance(60);
  const b = eventOf(await sell(U / 2n), 'Buyback');
  c = await w.config();
  assert.equal(c.auction.lastPrice, (b.price as bigint) * 2n);
  assert.equal(auctionPrice(c.auction, await chain.now()), (b.price as bigint) * 3n);
  await w.assertBooks('quick refill');
});

