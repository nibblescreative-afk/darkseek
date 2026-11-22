// An upgrade in place from a previous release. The previous release's program
// plays rounds and leaves a lobby forming; then this build replaces it at the
// same address through the loader's Upgrade instruction, as the upgrade
// authority does on a cluster, and every account the old program wrote must
// still decode, play on and balance to the base unit. Two deployments: one
// before $DS is recorded (as on devnet) and one after (as on testnet).
//
// Releases up to v0.4.1 are SBPF v0 and this build is SBPF v3, so this is also
// the move from one to the other. Once SIMD-0500 is active the clusters take
// no new v0, v1 or v2 program, not even as an upgrade; a deployed v0 program
// keeps running and can still be upgraded to v3. LiteSVM does not enforce
// SIMD-0500, so the version itself is checked from the ELF header.
//
// It needs the previous release's darkseek_vault.so, which is not in the
// repository: download it from the GitHub release and check it against the
// release's SHA256SUMS (docs/verify.md), then
//   scripts/build-program.sh
//   DS_PREVIOUS_SO=path/to/darkseek_vault.so npx tsx --test tests/upgrade.test.ts
// Without DS_PREVIOUS_SO only the build's SBPF version is checked. CI runs it
// from every release a cluster may still run (.github/workflows/validator.yml).

import fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { LEAVE_AFTER_SECS, PROGRAM_ID, SURVIVED, configChecks, ixs, pda } from '../packages/sdk/src/index.js';
import { PROGRAM_SO, SvmChain } from './harness/chain.js';
import { U, World, eventOf, expectError } from './harness/world.js';

const PREVIOUS = process.env.DS_PREVIOUS_SO;
const skip = PREVIOUS ? false : 'set DS_PREVIOUS_SO to the previous release\'s darkseek_vault.so';
/**
 * Releases from v0.4.0 have leave_seat, whose lobbies hold their players for 30
 * minutes, and send the whole fee to the treasury until $DS is recorded. v0.3.0
 * has no leave_seat and fills the staker, rebate and buyback pools from the start.
 */
const FROM_040 = PREVIOUS ? fs.readFileSync(PREVIOUS).includes('Instruction: LeaveSeat') : false;

/** e_machine and e_flags of a program's ELF header: SBPF v3 is 247 (EM_BPF) and 3, v0 has e_flags 0. */
function sbpf(file: string): { machine: number; flags: number } {
  const elf = fs.readFileSync(file);
  return { machine: elf.readUInt16LE(18), flags: elf.readUInt32LE(48) };
}

test('the build is SBPF v3, which the clusters still take once SIMD-0500 is active', () => {
  assert.deepEqual(sbpf(PROGRAM_SO), { machine: 247, flags: 3 });
});

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

/** UpgradeableLoaderState::ProgramData before the program: tag, slot, upgrade authority */
const PROGRAMDATA_HEADER = 45;

async function upgrade(chain: SvmChain, w: World): Promise<void> {
  const before = await snapshot(w);
  await w.assertBooks('the previous release');
  await chain.advance(1);
  await chain.upgrade(PROGRAM_SO, w.admin);
  await chain.advance(1);
  // the build fits the program data the previous release was deployed with (no
  // extend first) and now fills it, zero padded
  const build = fs.readFileSync(PROGRAM_SO);
  const held = (await chain.account(pda.programData(PROGRAM_ID)))!.data.subarray(PROGRAMDATA_HEADER);
  assert.ok(held.subarray(0, build.length).equals(build) && held.subarray(build.length).every((b) => b === 0), 'the program data holds this build');
  assert.deepEqual(await snapshot(w), before, 'the upgrade itself writes nothing');
  await w.assertBooks('right after the upgrade');
}

const leave = (chain: SvmChain, w: World, who: Keypair, room: number, round: bigint, slot: number) => chain.send([ixs.leaveSeat(who.publicKey, room, round, slot)], [w.admin, who]);

/** A lobby that was forming at the upgrade keeps the clock the previous release gave it; v0.3.0 gave none. */
async function leaveOldLobby(chain: SvmChain, w: World, who: Keypair, room: number, round: bigint, slot: number): Promise<Record<string, unknown>> {
  if (FROM_040) {
    await expectError(leave(chain, w, who, room, round, slot), 'TooEarly');
    await chain.advance(Number(LEAVE_AFTER_SECS));
  }
  return eventOf(await leave(chain, w, who, room, round, slot), 'SeatLeft');
}

test('an upgrade before $DS is recorded: rooms, vaults and the waiting fees carry on', { skip }, async () => {
  const { chain, w } = await previousRelease(false);
  const ten = await w.players(10, 50n * U);
  await w.play(1, 1n, keys(ten), OUTCOMES);
  // v0.3.0 fills the pools before $DS is recorded; from v0.4.0 the whole fee goes to the treasury
  const waited = await w.config();
  if (FROM_040) assert.deepEqual([waited.stakerPool, waited.rebatePool, waited.buybackPool], [0n, 0n, 0n]);
  else assert.ok(waited.rebatePool > 0n && waited.buybackPool > 0n);
  // a lobby is forming when the upgrade lands
  await w.seat(2, 1n, keys(ten.slice(0, 4)));
  await expectError(leave(chain, w, ten[0], 2, 1n, 0), FROM_040 ? 'TooEarly' : /InstructionFallbackNotFound/);

  await upgrade(chain, w);

  // the verifier warns about the fees that waited, if any did
  const waits = configChecks(await w.config()).find((c) => c.name.startsWith('no fee waits'));
  assert.ok(waits?.warn);
  assert.equal(waits.ok, FROM_040);
  // the lobby's players may leave once it has been forming for 30 minutes (under v0.3.0, at once)
  const left = await leaveOldLobby(chain, w, ten[0], 2, 1n, 0);
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
  const ev = eventOf((await w.play(5, 4n, keys(ten), OUTCOMES)).started, 'RoundStarted');
  assert.ok((ev.toStakers as bigint) > 0n, 'with $DS recorded the split is as before');
  await claim();
  assert.ok((await w.vault(staker.publicKey)).balance > claimed, 'the staker keeps earning');
  // the fill before the upgrade was seconds ago: this one counts as a quick refill
  const b = eventOf(await sell(10n * U), 'Buyback');
  assert.equal((await w.config()).auction.lastPrice, 2n * (b.price as bigint));
  // last, as it may move the clock 30 minutes
  await leaveOldLobby(chain, w, ten[0], 6, 1n, 0);
  await w.assertBooks('after the upgrade');
});
