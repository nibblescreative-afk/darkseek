// The indexer against a local validator: rounds, a cancel, staking, an auction
// fill and a sweep happen onchain; the indexer must store every event once and
// its totals must equal the program's own running totals.
//
// Run: scripts/build-program.sh && npm run build -w @darkseek/sdk && npm test -w @darkseek/indexer

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Keypair } from '@solana/web3.js';
import { PROGRAM_ID, SURVIVED, ata, ixs, splIxs } from '../../../packages/sdk/src/index.js';
import { ValidatorChain } from '../../../tests/harness/chain.js';
import { DEFAULT_DS_ARGS, U, World } from '../../../tests/harness/world.js';
import { Store } from '../src/store.js';
import { Follower } from '../src/follower.js';
import { createApi } from '../src/api.js';
import type http from 'node:http';

const S = SURVIVED;
let chain: ValidatorChain;
let w: World;
let dir: string;
let store: Store;
let server: http.Server;
let base: string;

const get = async (p: string) => {
  const r = await fetch(base + p);
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};

before(async () => {
  const admin = Keypair.generate();
  chain = await ValidatorChain.start(admin.publicKey, Number(process.env.DS_TEST_PORT_INDEXER ?? 30_899));
  // a 1 USDC buyback target, so the activity below completes a buyback round
  w = await new World(chain, admin).setup({ ds: { ...DEFAULT_DS_ARGS, buybackTarget: U } });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkseek-indexer-test-'));
});

after(async () => {
  server?.close();
  store?.close();
  await chain?.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  setTimeout(() => process.exit(), 500).unref();
});

let ten: Keypair[];

test('activity onchain: rounds, a cancel, staking, an auction fill, a sweep', async () => {
  ten = await w.players(10, 200n * U);
  const keys = ten.map((k) => k.publicKey);
  await w.play(1, 1n, keys, [0, 0, 0, 1, S, S, S, S]);
  await w.play(4, 1n, keys, [0, 0, 0, 0, 0, 0, 1, 1]);
  await w.seat(2, 1n, keys);
  await w.start(2, 1n);
  await chain.send([ixs.cancelRound(w.authority.publicKey, 2, 1n, keys)], [w.authority]);
  const staker = await w.player(1n * U, { ds: 500n * U });
  await chain.send([ixs.depositDs(staker.publicKey, w.ds, staker.publicKey, 500n * U), ixs.stakeDs(staker.publicKey, 500n * U)], [w.admin, staker]);
  await w.play(5, 1n, keys, [0, 1, S, S, S, S, S, S]);
  await chain.send([ixs.claimRewards(staker.publicKey)], [w.admin]);
  const seller = await w.player(1n * U, { ds: 1_000n * U });
  await chain.send([ixs.sellDs(seller.publicKey, w.usdc, w.ds, 500n * U, 0n)], [w.admin, seller]);
  await chain.send([ixs.claimRebate(ten[2].publicKey)], [w.admin]);
  await chain.send([splIxs.createAtaIdempotent(w.admin.publicKey, w.admin.publicKey, w.usdc)], [w.admin]);
  await chain.send([ixs.sweepTreasury(w.admin.publicKey, w.usdc, ata(w.admin.publicKey, w.usdc), 1n * U)], [w.admin]);
  await w.assertBooks('activity');
});

test('the indexer stores every event once, and resumes where it stopped', async () => {
  store = new Store(path.join(dir, 'indexer.sqlite'));
  const follower = new Follower({ conn: chain.conn, programId: PROGRAM_ID, store, commitment: 'confirmed' });
  const first = await follower.syncOnce();
  assert.ok(first > 20, `processed ${first} transactions`);
  const events = store.eventCount();
  assert.equal(await follower.syncOnce(), 0, 'nothing new');

  // a new process on the same database picks up only what is new
  await w.play(1, 2n, ten.map((k) => k.publicKey), [S, S, S, S, S, S, S, S]);
  const again = new Follower({ conn: chain.conn, programId: PROGRAM_ID, store, commitment: 'confirmed' });
  assert.equal(await again.syncOnce(), 3, 'lock, start and settle');
  assert.ok(store.eventCount() > events);

  server = createApi({ store, follower: again, conn: chain.conn, programId: PROGRAM_ID, cluster: 'localnet', solvencyCacheMs: 0 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test('/stats: the indexed totals equal the program\'s own running totals', async () => {
  const { status, body } = await get('/stats');
  assert.equal(status, 200);
  const t = body.onchain.totals;
  const i = body.indexed;
  assert.equal(i.rounds.started, t.roundsStarted);
  assert.equal(i.rounds.settled, t.roundsSettled);
  assert.equal(i.rounds.refunded, t.roundsRefunded);
  assert.equal(i.staked, t.staked);
  assert.deepEqual(i.fees, { total: t.fees, stakers: t.toStakers, rebate: t.toRebate, buyback: t.toBuyback, treasury: t.toTreasury });
  assert.equal(i.buyback.usdcFromBuyback, t.buybackSpent);
  assert.equal(i.buyback.usdcFromRebate, t.rebateSpent);
  assert.equal(i.buyback.dsBurned, t.dsBurned);
  assert.ok(BigInt(i.buyback.dsBurned) > 0n, 'some $DS was burned');
  assert.equal(i.buyback.dsToReserve, t.dsToReserve);
  assert.equal(i.rebates.credited, t.rebatesCredited);
  assert.equal(i.rebates.claimed, t.rebatesClaimed);
  assert.equal(i.rebates.dsPaid, t.dsRebated);
  assert.ok(BigInt(i.rebates.dsPaid) > 0n, 'a rebate was paid in $DS');
  assert.equal(body.onchain.buyback.roundsDone, '1');
  assert.equal(body.onchain.buyback.target, '980000', 'the second round spends 98% of the first');
  assert.equal(i.treasurySwept, t.treasurySwept);
  assert.equal(i.ds.staked, body.onchain.dsStaked);
  assert.deepEqual(i.byTier.map((x: { tier: string }) => x.tier), ['casual', 'pro']);
});

test('/rounds/:room/:round: seats, fee split, outcome, payouts and rebates', async () => {
  const { status, body } = await get('/rounds/1/1');
  assert.equal(status, 200);
  assert.equal(body.status, 'settled');
  assert.equal(body.tier, 'casual');
  assert.deepEqual(body.fee, { total: '700000', stakers: '70000', rebate: '140000', buyback: '140000', treasury: '350000' });
  assert.equal(body.seekersWon, false);
  assert.deepEqual(
    body.seats.map((s: { payout: string }) => s.payout),
    ['1350000', '450000', '0', '0', '0', '0', '1125000', '1125000', '1125000', '1125000'],
  );
  assert.equal(body.seats[0].owner, ten[0].publicKey.toBase58());
  assert.equal(body.seats[2].rebateUsdc, '23333');
  assert.equal(body.seats[6].rebateUsdc, '0');
  assert.match(body.transactions.ended, /^https:\/\//);

  const cancelled = await get('/rounds/2/1');
  assert.equal(cancelled.body.status, 'refunded');
  assert.equal(cancelled.body.refunds[0], '1350000', 'a Seeker stake back less the fee');
  assert.equal(cancelled.body.seats[5].rebateUsdc, '14000', 'every seat of a round cancelled after its start shares the rebate');

  assert.equal((await get('/rounds/3/9')).status, 404);
  assert.equal((await get('/rounds/9/1')).status, 400);
  assert.equal((await get('/rounds')).body.length, 5);
});

test('/solvency and /health', async () => {
  const s = await get('/solvency');
  assert.equal(s.status, 200);
  assert.equal(s.body.ok, true);
  assert.equal(s.body.usdc.surplus, '0');
  const h = await get('/health');
  assert.equal(h.body.ok, true);
  const e = await get('/events?name=Buyback');
  assert.equal(e.body.length, 1);
  assert.equal(e.body[0].name, 'Buyback');
  const r = await fetch(base + '/stats', { method: 'POST' });
  assert.equal(r.status, 405);
});
