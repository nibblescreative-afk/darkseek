// An upgrade in place from the previous release. The previous release's program
// plays rounds and leaves a lobby forming; then this build replaces it at the
// same address, as an upgrade by the upgrade authority does, and every account
// the old program wrote must still decode, play on and balance to the base
// unit. Two deployments: one before $DS is recorded (as on devnet) and one after
// (as on testnet).
//
// It needs the previous release's darkseek_vault.so, which is not in the
// repository: download it from the GitHub release and check it against the
// release's SHA256SUMS (docs/verify.md), then
//   scripts/build-program.sh
//   DS_PREVIOUS_SO=path/to/darkseek_vault.so npx tsx --test tests/upgrade.test.ts
// Without DS_PREVIOUS_SO it is skipped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { LEAVE_AFTER_SECS, SURVIVED, configChecks, ixs, pda } from '../packages/sdk/src/index.js';
import { PROGRAM_SO, SvmChain } from './harness/chain.js';
import { U, World, eventOf, expectError } from './harness/world.js';

const PREVIOUS = process.env.DS_PREVIOUS_SO;
const skip = PREVIOUS ? false : 'set DS_PREVIOUS_SO to the previous release\'s darkseek_vault.so';
const S = SURVIVED;
/** Seeker 0 catches two Hiders, Seeker 1 two, four survive */
const OUTCOMES = [0, 0, 1, 1, S, S, S, S];
const keys = (ks: Keypair[]) => ks.map((k) => k.publicKey);

/** A deployment running the previous release, with $DS recorded or not. */
async function previousRelease(withDs: boolean): Promise<{ chain: SvmChain; w: World }> {
  const admin = Keypair.generate();
  const chain = new SvmChain(admin.publicKey);
  chain.deploy(PREVIOUS!);
  const w = new World(chain, admin);
  if (withDs) await w.setup();
  else {
    await w.fundKeys();
    await w.createMint(w.usdcMint);
    await chain.send([w.initializeIx()], [w.admin]);
    await w.createRooms();
  }
  return { chain, w };
}

/** The bytes of every account the program owns in this world. */
async function snapshot(w: World): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const list: PublicKey[] = [pda.config(), ...[1, 2, 3, 4, 5, 6].map((i) => pda.room(i)), ...w.owners.map((o) => pda.vault(o))];
  for (const key of list) out[key.toBase58()] = (await w.chain.account(key))!.data.toString('hex');
  return out;
}

async function upgrade(chain: SvmChain, w: World): Promise<void> {
  const before = await snapshot(w);
  await w.assertBooks('the previous release');
  chain.deploy(PROGRAM_SO);
  await chain.advance(1);
  assert.deepEqual(await snapshot(w), before, 'the upgrade itself writes nothing');
  await w.assertBooks('right after the upgrade');
}

const leave = (chain: SvmChain, w: World, who: Keypair, room: number, round: bigint, slot: number) => chain.send([ixs.leaveSeat(who.publicKey, room, round, slot)], [w.admin, who]);

test('an upgrade before $DS is recorded: rooms, vaults and the waiting fees carry on', { skip }, async () => {
  const { chain, w } = await previousRelease(false);
  const ten = await w.players(10, 50n * U);
  await w.play(1, 1n, keys(ten), OUTCOMES);
  // the previous release fills the pools before $DS is recorded
  const waited = await w.config();
  assert.ok(waited.rebatePool > 0n && waited.buybackPool > 0n);
  // a lobby is forming when the upgrade lands
  await w.seat(2, 1n, keys(ten.slice(0, 4)));
  await expectError(leave(chain, w, ten[0], 2, 1n, 0), /InstructionFallbackNotFound/);

  await upgrade(chain, w);

  // the verifier sees the fees that waited, as a warning
  const warn = configChecks(await w.config()).find((c) => c.name.startsWith('no fee waits'));
  assert.ok(warn && !warn.ok && warn.warn);
  // the lobby's clock is from before the upgrade, already past 30 minutes: its players may leave at once
  const left = eventOf(await leave(chain, w, ten[0], 2, 1n, 0), 'SeatLeft');
  assert.equal(String(left.owner), ten[0].publicKey.toBase58());
  // the lobby fills and plays; the whole fee now goes to the treasury, and what waited stays put
  await w.seat(2, 1n, [ten[0].publicKey], 0);
  await w.seat(2, 1n, keys(ten.slice(4)), 4);
  const ev = eventOf(await w.start(2, 1n), 'RoundStarted');
  assert.deepEqual([ev.toStakers, ev.toRebate, ev.toBuyback], [0n, 0n, 0n]);
  const c = await w.config();
  assert.deepEqual([c.stakerPool, c.rebatePool, c.buybackPool, c.rewardCarry], [waited.stakerPool, waited.rebatePool, waited.buybackPool, waited.rewardCarry]);
  assert.equal(c.treasury - waited.treasury, ev.toTreasury);
  await w.settle(2, 1n, OUTCOMES, keys(ten));
  // a settled room from before the upgrade takes only its next round number
  await expectError(w.seat(1, 3n, [ten[0].publicKey]), 'WrongRound');
  await w.play(1, 2n, keys(ten), OUTCOMES);
  // a lobby formed after the upgrade keeps its players for 30 minutes
  await w.seat(3, 1n, [ten[0].publicKey]);
  await expectError(leave(chain, w, ten[0], 3, 1n, 0), 'TooEarly');
  await chain.advance(Number(LEAVE_AFTER_SECS));
  eventOf(await leave(chain, w, ten[0], 3, 1n, 0), 'SeatLeft');
  await w.assertBooks('after the upgrade');
});

test('an upgrade after $DS is recorded: staking, the auction and a forming lobby carry on', { skip }, async () => {
  const { chain, w } = await previousRelease(true);
  const staker = await w.player(1n * U, { ds: 1_000n * U });
  await chain.send([ixs.depositDs(staker.publicKey, w.ds, staker.publicKey, 1_000n * U, w.dsTokenProgram), ixs.stakeDs(staker.publicKey, 500n * U)], [w.admin, staker]);
  const ten = await w.players(10, 50n * U);
  for (let r = 1n; r <= 3n; r++) await w.play(5, r, keys(ten), OUTCOMES);
  const seller = await w.player(1n * U, { ds: 1_000n * U });
  const sell = (maxDs: bigint) => chain.send([ixs.sellDs(seller.publicKey, w.usdc, w.ds, maxDs, 0n, w.dsTokenProgram)], [w.admin, seller]);
  eventOf(await sell(10n * U), 'Buyback');
  const claim = () => chain.send([ixs.claimRewards(staker.publicKey)], [w.admin]);
  await claim();
  const claimed = (await w.vault(staker.publicKey)).balance;
  assert.ok(claimed > 1n * U, 'the staker earned under the previous release');
  await w.seat(6, 1n, keys(ten.slice(0, 3)));

  await upgrade(chain, w);

  assert.deepEqual(configChecks(await w.config()).filter((c) => !c.ok && !c.warn), []);
  eventOf(await leave(chain, w, ten[0], 6, 1n, 0), 'SeatLeft');
  const ev = eventOf((await w.play(5, 4n, keys(ten), OUTCOMES)).started, 'RoundStarted');
  assert.ok((ev.toStakers as bigint) > 0n, 'with $DS recorded the split is as before');
  await claim();
  assert.ok((await w.vault(staker.publicKey)).balance > claimed, 'the staker keeps earning');
  // the fill before the upgrade was seconds ago: this one counts as a quick refill
  const b = eventOf(await sell(10n * U), 'Buyback');
  assert.equal((await w.config()).auction.lastPrice, 2n * (b.price as bigint));
  await w.assertBooks('after the upgrade');
});
