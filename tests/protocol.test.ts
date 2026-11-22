// The vault program end to end on a local validator: the real runtime, SPL
// Token and RPC. After every step the books must balance exactly:
//   USDC custody == vault balances + room pots + treasury + staker, rebate and buyback pools
//   $DS custody  == reserve + every vault's free and staked $DS
//
// Run: scripts/build-program.sh && npx tsx --test tests/protocol.test.ts

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  DS_TOTAL_SUPPLY,
  EXT,
  PROGRAM_ID,
  PUBLISHED,
  SURVIVED,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  accrueRewards,
  ata,
  auctionFill,
  auctionPrice,
  buybackTargetAfter,
  checkSolvency,
  configChecks,
  decodeMint,
  earned,
  fetchProgramInfo,
  executableHash,
  ixs,
  losersMask,
  maskSlots,
  payoutsFor,
  pda,
  rebateClaim,
  rebatePerLoser,
  seatStakes,
  splitFee,
  splIxs,
} from '../packages/sdk/src/index.js';
import { PROGRAM_SO, ROOT, ValidatorChain } from './harness/chain.js';
import { U, World, eventOf, eventsOf, expectError } from './harness/world.js';

const S = SURVIVED;
let chain: ValidatorChain;
let w: World;
let ten: Keypair[];
const keys = (ks: Keypair[]) => ks.map((k) => k.publicKey);
let round = 0n; // the round in play in a test's room
/** The round a room's next seat must use, as the game picks it: the open lobby's, or the one after (never further, v0.4.0). */
const nextRound = async (room: number): Promise<bigint> => {
  const r = await w.room(room);
  return r.status === 0 ? r.round : r.round + 1n;
};
// as if the launch buy (3% of supply) had been worth 6 USDC: the first buyback round spends 3
const DS_ARGS = { genesisPrice: 100n * U, floorPrice: U, duration: 21_600n, lot: 1_000n * U, minFill: U / 100n, buybackTarget: 3n * U };

before(async () => {
  const admin = Keypair.generate();
  chain = await ValidatorChain.start(admin.publicKey, Number(process.env.DS_TEST_PORT ?? 28_899));
  w = new World(chain, admin);
});

after(async () => {
  await chain?.stop();
  // web3.js keeps a websocket open to the stopped validator; leave once the results are out
  setTimeout(() => process.exit(), 500).unref();
});

test('only the upgrade authority can initialize, and only once', async () => {
  await w.fundKeys();
  await w.createMint(w.usdcMint);
  const stranger = Keypair.generate();
  await chain.airdrop(stranger.publicKey, 2);
  await expectError(chain.send([w.initializeIx(stranger.publicKey)], [stranger]), 'NotAdmin');

  const init = await chain.send([w.initializeIx()], [w.admin]);
  const ev = eventOf(init, 'ConfigInitialized');
  assert.ok((ev.admin as PublicKey).equals(w.admin.publicKey));
  assert.ok((ev.authority as PublicKey).equals(w.authority.publicKey));
  await expectError(chain.send([w.initializeIx()], [w.admin]), /already in use/);

  await w.createRooms();
  await expectError(chain.send([ixs.initRoom(w.admin.publicKey, 1, 0)], [w.admin]), /already in use/);
  await expectError(chain.send([ixs.initRoom(stranger.publicKey, 1, 0)], [stranger]), /NotAdmin|already in use/);
  for (let i = 1; i <= 6; i++) assert.equal((await w.room(i)).tier, i <= 3 ? 0 : 1);
});

test('until $DS is recorded the whole fee goes to the treasury and the other pools stay empty (v0.4.0)', async () => {
  // a pro room (5): the session test below uses rooms 1 to 3 from round 1
  const early = await w.players(10, 20n * U);
  const before = await w.config();
  const { started, settled } = await w.play(5, await nextRound(5), keys(early), [S, S, S, S, S, S, S, S]);
  const ev = eventOf(started, 'RoundStarted');
  assert.deepEqual([ev.toStakers, ev.toRebate, ev.toBuyback, ev.toTreasury], [0n, 0n, 0n, 3_500_000n]);
  const after = await w.config();
  assert.deepEqual(
    [after.stakerPool, after.rebatePool, after.buybackPool, after.rebateCredits, after.rewardCarry],
    [before.stakerPool, before.rebatePool, before.buybackPool, before.rebateCredits, before.rewardCarry],
    'nothing waits for a $DS mint that the admin has yet to choose',
  );
  assert.equal(after.treasury - before.treasury, 3_500_000n);
  assert.equal(eventOf(settled, 'RoundSettled').rebateUsdc, 0n);
  await w.assertBooks('a round before $DS');
});

test('no vault for the all zero key, which marks empty seats (v0.4.0)', async () => {
  await expectError(chain.send([ixs.openVault(w.admin.publicKey, PublicKey.default)], [w.admin]), 'BadParams');
});

test('$DS is recorded once, on Token 2022 like a pump.fun mint, and only if nobody can mint or freeze it', async () => {
  // a token whose mint authority still exists is refused
  const loose = Keypair.generate();
  await w.createMint(loose);
  await expectError(chain.send([ixs.initDs(w.admin.publicKey, loose.publicKey, DS_ARGS)], [w.admin]), 'DsNotFixed');

  // a pump.fun coin in Mayhem mode has two billion, twice the published supply (v0.4.0)
  const mayhem = Keypair.generate();
  await w.createPumpLikeMint(mayhem, 'token-2022', 2n * DS_TOTAL_SUPPLY);
  await expectError(chain.send([ixs.initDs(w.admin.publicKey, mayhem.publicKey, DS_ARGS, TOKEN_2022_PROGRAM_ID)], [w.admin]), 'DsSupply');

  await w.createDs('token-2022');
  assert.ok(w.dsTokenProgram.equals(TOKEN_2022_PROGRAM_ID));
  // as pump.fun's CreateV2 leaves it: nobody can change the metadata
  const meta = decodeMint((await chain.account(w.ds))!.data, TOKEN_2022_PROGRAM_ID).extensions.get(EXT.TokenMetadata)!;
  assert.ok(Buffer.from(meta.subarray(0, 32)).equals(Buffer.alloc(32)), 'no metadata update authority');
  const stranger = Keypair.generate();
  await chain.airdrop(stranger.publicKey, 2);
  const init = (signer: Keypair, args = DS_ARGS, program = w.dsTokenProgram) => chain.send([ixs.initDs(signer.publicKey, w.ds, args, program)], [signer]);
  await expectError(init(stranger), 'NotAdmin');
  await expectError(init(w.admin, { ...DS_ARGS, genesisPrice: U / 2n }), 'BadParams');
  await expectError(init(w.admin, { ...DS_ARGS, buybackTarget: 0n }), 'BadParams');
  // v0.4.0 bounds: legs shorter than six hours or longer than a week, a lot over 100 000 USDC or a first
  // target over 1 000 000 USDC are refused; the floor may be as low as one base unit (no fixed limit)
  await expectError(init(w.admin, { ...DS_ARGS, duration: 21_599n }), 'BadParams');
  await expectError(init(w.admin, { ...DS_ARGS, duration: 8n * 86_400n }), 'BadParams');
  await expectError(init(w.admin, { ...DS_ARGS, lot: 100_001n * U }), 'BadParams');
  await expectError(init(w.admin, { ...DS_ARGS, buybackTarget: 1_000_001n * U }), 'BadParams');
  await expectError(init(w.admin, DS_ARGS, TOKEN_PROGRAM_ID), /ConstraintMintTokenProgram|AccountOwnedByWrongProgram|IncorrectProgramId/);
  const tx = await init(w.admin);
  const ev = eventOf(tx, 'DsConfigured');
  assert.ok((ev.dsMint as PublicKey).equals(w.ds));
  assert.ok((ev.dsTokenProgram as PublicKey).equals(TOKEN_2022_PROGRAM_ID));
  assert.equal(ev.buybackTarget, 3n * U);
  const c = await w.config();
  assert.deepEqual([c.buybackTarget, c.buybackTargetInitial, c.buybacksDone, c.buybackRoundLeft], [3n * U, 3n * U, 0n, 0n]);
  await expectError(init(w.admin), /already in use|DsAlreadySet/);
  await w.assertBooks('setup');
});

test('the settings onchain are the published ones', async () => {
  const checks = configChecks(await w.config(), { usdcMint: w.usdc, dsMint: w.ds, admin: w.admin.publicKey, authority: w.authority.publicKey });
  assert.ok(checks.every((c) => c.ok), JSON.stringify(checks.filter((c) => !c.ok)));
});

test('only the owner can take USDC out of a vault: not the game server, not the admin', async () => {
  const a = await w.player(50n * U);
  const out = await chain.send([ixs.withdraw(a.publicKey, w.usdc, 5n * U)], [w.admin, a]);
  assert.equal(eventOf(out, 'Withdrawn').amount, 5n * U);
  assert.equal((await w.vault(a.publicKey)).balance, 45n * U);
  assert.equal(await w.tokens(ata(a.publicKey, w.usdc)), 5n * U);
  await chain.send([ixs.deposit(a.publicKey, w.usdc, a.publicKey, 5n * U)], [w.admin, a]);

  for (const thief of [w.authority, w.admin]) {
    await chain.send([splIxs.createAtaIdempotent(thief.publicKey, thief.publicKey, w.usdc)], [thief]);
    // the thief signs as "owner" but points at the player's vault
    const ix = ixs.withdraw(thief.publicKey, w.usdc, 1n * U);
    ix.keys[5] = { pubkey: pda.vault(a.publicKey), isSigner: false, isWritable: true };
    await expectError(chain.send([ix], [thief]), /ConstraintSeeds|ConstraintHasOne/);
  }
  assert.equal((await w.vault(a.publicKey)).balance, 50n * U);
  await w.assertBooks('withdrawals');
});

test('the game server needs a session to stake and stays within its daily cap', async () => {
  const noSession = await w.player(50n * U, { session: false });
  await expectError(w.seat(1, 1n, [noSession.publicKey]), 'NoSession');

  const capped = await w.player(50n * U, { cap: 2n * U });
  await w.seat(1, 1n, [capped.publicKey], 0); // Seeker 1.50
  await w.seat(2, 1n, [capped.publicKey], 2); // Hider 0.50: 2.00 today
  await expectError(w.seat(3, 1n, [capped.publicKey], 2), 'OverDailyCap');
  const v = await w.vault(capped.publicKey);
  assert.equal(v.balance, 48n * U);
  assert.equal(v.locked, 2n * U);

  const other = await w.player(50n * U);
  await expectError(w.seat(1, 1n, [capped.publicKey], 3), 'AlreadySeated');
  await expectError(w.seat(1, 1n, [other.publicKey], 0), 'SeatTaken');
  await expectError(w.seat(1, 2n, [other.publicKey], 4), 'WrongRound');

  // the server hands the stakes back before any round starts
  const back = await chain.send([ixs.unlockStake(w.authority.publicKey, 1, capped.publicKey, 1n, 0), ixs.unlockStake(w.authority.publicKey, 2, capped.publicKey, 1n, 2)], [w.authority]);
  assert.equal(eventsOf(back).filter((e) => e.name === 'StakeUnlocked').length, 2);
  assert.equal((await w.vault(capped.publicKey)).balance, 50n * U);
  // a refunded stake still counts toward today's cap
  await expectError(w.seat(3, 1n, [capped.publicKey], 2), 'OverDailyCap');

  // a revoked session stops the server at once
  await chain.send([ixs.setSession(other.publicKey, 0n, 0n)], [w.admin, other]);
  await expectError(w.seat(3, 1n, [other.publicKey], 2), 'NoSession');
  await w.assertBooks('lobby');
});

test('a round starts only when all ten seats are staked by players', async () => {
  ten = await w.players(10, 200n * U);
  round = await nextRound(1);
  await w.seat(1, round, keys(ten).slice(0, 9));
  await expectError(w.start(1, round), 'RoomNotFull');
  await w.seat(1, round, [ten[9].publicKey], 9);
  const before = await w.config();
  const started = await w.start(1, round);

  const ev = eventOf(started, 'RoundStarted');
  const parts = splitFee(700_000n, PUBLISHED.split);
  assert.equal(ev.gross, 7n * U);
  assert.equal(ev.fee, 700_000n);
  assert.deepEqual([ev.toStakers, ev.toRebate, ev.toBuyback, ev.toTreasury], [70_000n, 140_000n, 140_000n, 350_000n]);
  assert.equal(ev.pot, 6_300_000n);
  assert.deepEqual((ev.owners as PublicKey[]).map(String), keys(ten).map(String));

  const after = await w.config();
  assert.equal(after.stakerPool - before.stakerPool, parts.stakers);
  assert.equal(after.rebatePool - before.rebatePool, parts.rebate);
  assert.equal(after.buybackPool - before.buybackPool, parts.buyback);
  assert.equal(after.treasury - before.treasury, parts.treasury);
  assert.equal(after.totals.fees - before.totals.fees, 700_000n);
  await expectError(w.seat(1, round, [ten[0].publicKey], 0), 'RoundRunning');
  await w.assertBooks('round started');
});

test('Hiders win: Seekers keep each catch, survivors split both Seeker stakes, losers get rebate credit', async () => {
  // Seeker 0 caught slots 2, 3, 4; Seeker 1 caught slot 5; slots 6 to 9 survive
  const outcomes = [0, 0, 0, 1, S, S, S, S];
  const before = await Promise.all(ten.map((p) => w.vault(p.publicKey)));
  const cfg = await w.config();
  const settled = await w.settle(1, round, outcomes, keys(ten));

  const stakes = seatStakes(PUBLISHED.stakes, 0);
  const payouts = payoutsFor(PUBLISHED.stakes, PUBLISHED.feeBps, 0, outcomes);
  const mask = losersMask(stakes, payouts);
  const rebate = rebatePerLoser(140_000n, maskSlots(mask).length);
  assert.equal(rebate, 23_333n, '0.14 USDC shared by six players who lost money');
  for (let slot = 0; slot < 10; slot++) {
    const v = await w.vault(ten[slot].publicKey);
    assert.equal(v.balance, before[slot].balance + payouts[slot], `slot ${slot} paid by the rules`);
    assert.equal(v.locked, 0n);
    assert.equal(v.rebateCredit - before[slot].rebateCredit, mask & (1 << slot) ? rebate : 0n, `slot ${slot} rebate credit`);
  }
  assert.deepEqual(payouts.map(Number), [1_350_000, 450_000, 0, 0, 0, 0, 1_125_000, 1_125_000, 1_125_000, 1_125_000]);

  const ev = eventOf(settled, 'RoundSettled');
  assert.equal(ev.seekersWon, false);
  assert.deepEqual(ev.payouts, payouts);
  assert.equal(ev.losers, mask);
  assert.equal(ev.rebateUsdc, rebate);
  assert.equal(ev.dust, 0n);
  assert.equal((await w.config()).rebateCredits - cfg.rebateCredits, rebate * 6n);
  await expectError(w.settle(1, round, outcomes, keys(ten)), 'WrongRound');
  await w.assertBooks('hiders win');
});

test('Seekers win only when every Hider is caught: own stake back plus each catch', async () => {
  const outcomes = [0, 0, 0, 0, 0, 0, 1, 1];
  const before = await Promise.all(ten.map((p) => w.vault(p.publicKey)));
  const { settled } = await w.play(4, await nextRound(4), keys(ten), outcomes);
  const payouts = payoutsFor(PUBLISHED.stakes, PUBLISHED.feeBps, 1, outcomes);
  assert.equal(payouts[0], 6_750_000n + 6n * 2_250_000n);
  assert.equal(payouts[1], 6_750_000n + 2n * 2_250_000n);
  const stakes = seatStakes(PUBLISHED.stakes, 1);
  for (let slot = 0; slot < 10; slot++) {
    const v = await w.vault(ten[slot].publicKey);
    assert.equal(v.balance, before[slot].balance - stakes[slot] + payouts[slot]);
  }
  const ev = eventOf(settled, 'RoundSettled');
  assert.equal(ev.seekersWon, true);
  assert.equal(ev.losers, 0b11_1111_1100, 'all eight Hiders lost money');
  assert.equal(ev.rebateUsdc, 87_500n, '0.70 USDC shared by eight');
  await w.assertBooks('seekers win');
});

test('the game server cannot pay anyone who is not seated, nor more than the room holds', async () => {
  round = await nextRound(2);
  await w.seat(2, round, keys(ten));
  await w.start(2, round);
  const outsider = await w.player(10n * U);
  const swapped = [ten[1], ten[0], ...ten.slice(2)];
  await expectError(w.settle(2, round, [S, S, S, S, S, S, S, S], keys(swapped)), 'MissingVault');
  await expectError(w.settle(2, round, [S, S, S, S, S, S, S, S], [...keys(ten).slice(0, 9), outsider.publicKey]), 'MissingVault');
  await expectError(w.settle(2, round, [S, S, S, S, S, S, S, S], keys(ten).slice(0, 9)), 'MissingVault');
  await expectError(w.settle(2, round, [7, S, S, S, S, S, S, S], keys(ten)), 'BadOutcome');
  const stranger = Keypair.generate();
  await chain.airdrop(stranger.publicKey, 1);
  await expectError(chain.send([ixs.settleRound(stranger.publicKey, 2, round, [S, S, S, S, S, S, S, S], keys(ten))], [stranger]), /ConstraintHasOne/);
  await expectError(chain.send([ixs.abortStaleRound(stranger.publicKey, 2, round, keys(ten))], [stranger]), 'NotStale');

  // nobody caught: the survivors split both Seeker stakes; 2.70 / 8 leaves no dust
  const settled = await w.settle(2, round, [S, S, S, S, S, S, S, S], keys(ten));
  assert.equal(eventOf(settled, 'RoundSettled').dust, 0n);
  assert.equal((await w.vault(outsider.publicKey)).balance, 10n * U);
  await w.assertBooks('settle checks');
});

test('a room only ever moves on to the next round number (v0.4.0)', async () => {
  const settled = (await w.room(2)).round;
  // a higher number would leave the room with no round after it
  await expectError(w.seat(2, settled + 2n, [ten[0].publicKey]), 'WrongRound');
  await expectError(w.seat(2, (1n << 64n) - 1n, [ten[0].publicKey]), 'WrongRound');
  await w.seat(2, settled + 1n, [ten[0].publicKey]);
  // an open lobby takes only its own round, and the next one only once it is empty
  await expectError(w.seat(2, settled + 2n, [ten[1].publicKey], 1), 'WrongRound');
  await chain.send([ixs.unlockStake(w.authority.publicKey, 2, ten[0].publicKey, settled + 1n, 0)], [w.authority]);
  await w.seat(2, settled + 2n, [ten[0].publicKey]);
  await chain.send([ixs.unlockStake(w.authority.publicKey, 2, ten[0].publicKey, settled + 2n, 0)], [w.authority]);
  await w.assertBooks('round numbers');
});

test('cancelling returns stakes: in full before the start, less the fee after it', async () => {
  round = await nextRound(3);
  const three = keys(ten).slice(0, 3);
  const before = await Promise.all(three.map((k) => w.vault(k)));
  await w.seat(3, round, three);
  const open = await chain.send([ixs.cancelRound(w.authority.publicKey, 3, round, three)], [w.authority]);
  assert.equal(eventOf(open, 'RoundRefunded').afterStart, false);
  for (let i = 0; i < 3; i++) assert.equal((await w.vault(three[i])).balance, before[i].balance);

  const all = await Promise.all(ten.map((p) => w.vault(p.publicKey)));
  const r5 = await nextRound(5);
  await w.seat(5, r5, keys(ten));
  await w.start(5, r5);
  const live = await chain.send([ixs.cancelRound(w.authority.publicKey, 5, r5, keys(ten))], [w.authority]);
  const ev = eventOf(live, 'RoundRefunded');
  assert.equal(ev.afterStart, true);
  assert.equal(ev.rebateUsdc, 70_000n, 'every seat lost the fee, so all ten share the rebate');
  const stakes = seatStakes(PUBLISHED.stakes, 1);
  for (let slot = 0; slot < 10; slot++) {
    const fee = stakes[slot] / 10n;
    assert.equal((await w.vault(ten[slot].publicKey)).balance, all[slot].balance - fee, 'stake back less the fee');
  }
  await w.assertBooks('cancel');
});

test('shop and P2P payments need the owner signature', async () => {
  const [buyer, seller] = [ten[0], ten[1]];
  const t0 = (await w.config()).treasury;
  const charged = await chain.send([ixs.charge(buyer.publicKey, 1n * U)], [w.admin, buyer]);
  assert.equal(eventOf(charged, 'Charged').amount, 1n * U);
  assert.equal((await w.config()).treasury - t0, 1n * U);
  const b0 = (await w.vault(seller.publicKey)).balance;
  await chain.send([ixs.pay(buyer.publicKey, seller.publicKey, 2n * U)], [w.admin, buyer]);
  assert.equal((await w.vault(seller.publicKey)).balance - b0, 2n * U);

  // the game server cannot spend for a player any more
  const charge = ixs.charge(w.authority.publicKey, 1n * U);
  charge.keys[2] = { pubkey: pda.vault(buyer.publicKey), isSigner: false, isWritable: true };
  await expectError(chain.send([charge], [w.authority]), /ConstraintSeeds|ConstraintHasOne/);
  const pay = ixs.pay(w.authority.publicKey, w.authority.publicKey, 1n * U);
  pay.keys[1] = { pubkey: pda.vault(buyer.publicKey), isSigner: false, isWritable: true };
  pay.keys[2] = { pubkey: pda.vault(seller.publicKey), isSigner: false, isWritable: true };
  await expectError(chain.send([pay], [w.authority]), /ConstraintSeeds|MissingVault/);
  await w.assertBooks('purchases');
});

test('$DS stakers share 10% of every fee (1% of every stake) in USDC, pro rata to stake', async () => {
  const s1 = await w.player(1n * U, { ds: 1_000n * U });
  const s2 = await w.player(1n * U, { ds: 1_000n * U });
  for (const [s, amount] of [[s1, 300n * U], [s2, 100n * U]] as const) {
    await chain.send([ixs.depositDs(s.publicKey, w.ds, s.publicKey, amount, w.dsTokenProgram), ixs.stakeDs(s.publicKey, amount)], [w.admin, s]);
  }
  await expectError(chain.send([ixs.stakeDs(s1.publicKey, 1n)], [w.admin, s1]), 'BadAmount');
  const c0 = await w.config();
  assert.equal(c0.dsStaked, 400n * U);

  round = await nextRound(6);
  await w.play(6, round, keys(ten), [0, 1, S, S, S, S, S, S]);
  // the pro round's 0.35 USDC for stakers, plus what waited while nobody staked
  const { acc, carry } = accrueRewards(c0.rewardPerDs, c0.rewardCarry, c0.dsStaked, 350_000n);
  const c1 = await w.config();
  assert.equal(c1.rewardPerDs, acc);
  assert.equal(c1.rewardCarry, carry);
  const v1 = await w.vault(s1.publicKey);
  const v2 = await w.vault(s2.publicKey);
  const r1 = earned(v1.dsStaked, acc, v1.rewardIndex);
  const r2 = earned(v2.dsStaked, acc, v2.rewardIndex);
  assert.ok(r1 > 262_500n && r2 > 87_500n, 'at least their share of this round');
  assert.ok(r1 - 3n * r2 <= 3n && 3n * r2 - r1 <= 3n, 'three to one, like the stakes');
  assert.ok(r1 + r2 <= c0.rewardCarry / 1_000_000_000_000n + 350_000n, 'never more than was paid in');

  // anyone may claim for a vault; the USDC can only land in that vault
  const claimed = await chain.send([ixs.claimRewards(s1.publicKey)], [w.admin]);
  assert.equal(eventOf(claimed, 'RewardsClaimed').amount, r1);
  assert.equal((await w.vault(s1.publicKey)).balance, 1n * U + r1);
  await expectError(chain.send([ixs.claimRewards(s1.publicKey)], [w.admin]), 'NothingToClaim');

  // unstake, withdraw the $DS to the wallet
  await chain.send([ixs.unstakeDs(s2.publicKey, 100n * U), ixs.claimRewards(s2.publicKey), ixs.withdrawDs(s2.publicKey, w.ds, 100n * U, w.dsTokenProgram)], [w.admin, s2]);
  assert.equal((await w.vault(s2.publicKey)).balance, 1n * U + r2);
  assert.equal(await w.tokens(ata(s2.publicKey, w.ds, w.dsTokenProgram)), 1_000n * U);
  await w.assertBooks('staking');
});

const sell = (seller: Keypair, maxDs: bigint, minUsdc = 0n) => chain.send([ixs.sellDs(seller.publicKey, w.usdc, w.ds, maxDs, minUsdc, w.dsTokenProgram)], [w.admin, seller]);
const blockTime = async (sig: string) => BigInt((await chain.conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }))!.blockTime!);

test('the auction buys $DS for rebates at any time; the buyback waits until its pool holds the whole target', async () => {
  const seller = await w.player(1n * U, { ds: 10_000n * U });
  const c = await w.config();
  assert.ok(c.buybackPool < c.buybackTarget, `pool ${c.buybackPool} still under the target ${c.buybackTarget}`);
  const supply = await w.supply(w.ds);
  const sold = await sell(seller, 30n * U);
  const ev = eventOf(sold, 'Buyback');
  const fill = auctionFill(ev.price as bigint, 30n * U, 0n, c.rebatePool, c.auction.lot, U)!;
  assert.deepEqual(
    { usdc: ev.usdc, ds: ev.ds, dsBurned: ev.dsBurned, dsToReserve: ev.dsToReserve, fromBuyback: ev.fromBuyback, fromRebate: ev.fromRebate },
    fill,
  );
  assert.equal(ev.fromBuyback, 0n, 'no buyback before the target');
  assert.equal(await w.supply(w.ds), supply, 'nothing burned');
  const t = await blockTime(sold.signature);
  assert.ok(ev.price === auctionPrice(c.auction, t) || ev.price === auctionPrice(c.auction, t - 1n), 'the price the rules give at that second');
  assert.ok((ev.price as bigint) <= 150n * U && (ev.price as bigint) > 140n * U, 'just under 1.5x the genesis price');
  assert.equal(await w.tokens(ata(seller.publicKey, w.usdc)), fill.usdc);
  assert.equal(await w.tokens(ata(seller.publicKey, w.ds, w.dsTokenProgram)), 10_000n * U - fill.ds);
  const after = await w.config();
  assert.equal(c.rebatePool - after.rebatePool, fill.usdc);
  assert.equal(after.dsReserve - c.dsReserve, fill.ds);
  assert.equal(after.reserveCost - c.reserveCost, fill.usdc, 'the reserve remembers what it paid');
  assert.equal(after.auction.lastPrice, ev.price);
  await w.assertBooks('rebate purchase');
});

test('a seller sets the least USDC they accept; dust fills are refused', async () => {
  const seller = await w.player(1n * U, { ds: 1_000n * U });
  const c = await w.config();
  // right after a fill the price restarts at 1.5x, so a seller expecting the old price is refused
  const atOldPrice = (100n * U * U) / c.auction.lastPrice;
  await expectError(sell(seller, 100n * U, atOldPrice), 'PriceMoved');
  await expectError(sell(seller, 1n * U), 'BelowMinFill');
  await w.assertBooks('auction limits');
});

test('a buyback round spends exactly the target, burns what it buys in the same instruction, then the target drops 2%', async () => {
  round = await nextRound(6);
  await w.play(6, round, keys(ten), [S, S, S, S, S, S, S, S]);
  const seller = await w.player(1n * U, { ds: 10_000n * U });
  const c = await w.config();
  assert.ok(c.buybackPool >= c.buybackTarget, 'the pool now holds the whole target');
  const supply = await w.supply(w.ds);
  const sold = await sell(seller, 5_000n * U);
  const ev = eventOf(sold, 'Buyback');
  assert.equal(ev.fromBuyback, 3n * U, 'the round spent exactly its target');
  assert.equal(ev.fromRebate, c.rebatePool, 'and the rebate pool, in the same fill');
  assert.equal(supply - (await w.supply(w.ds)), ev.dsBurned, 'the $DS supply fell by what the buyback bought');
  assert.ok((ev.dsBurned as bigint) > 0n);
  assert.equal(ev.buybacksDone, 1n);
  assert.equal(ev.buybackTarget, 2_940_000n, 'the next round spends 98% of this one');
  assert.equal(ev.buybackRoundLeft, 0n);
  const after = await w.config();
  assert.equal(after.buybackTarget, buybackTargetAfter(after.buybackTargetInitial, after.buybacksDone));
  assert.equal(after.totals.dsBurned, ev.dsBurned);
  assert.equal(after.buybackPool, c.buybackPool - 3n * U);
  // nothing left on offer: the buyback waits for its next target, the rebate pool is empty
  await expectError(sell(seller, 1_000n * U), 'BelowMinFill');
  await w.assertBooks('buyback round');
});

test('the buyback and rebate pools never reach the treasury or the admin', async () => {
  const c = await w.config();
  const to = ata(w.admin.publicKey, w.usdc);
  await chain.send([splIxs.createAtaIdempotent(w.admin.publicKey, w.admin.publicKey, w.usdc)], [w.admin]);
  await expectError(chain.send([ixs.sweepTreasury(w.admin.publicKey, w.usdc, to, c.treasury + 1n)], [w.admin]), 'BadAmount');
  await expectError(chain.send([ixs.sweepTreasury(w.authority.publicKey, w.usdc, to, 1n)], [w.authority]), 'NotAdmin');
  const swept = await chain.send([ixs.sweepTreasury(w.admin.publicKey, w.usdc, to, c.treasury)], [w.admin]);
  assert.equal(eventOf(swept, 'TreasurySwept').treasury, 0n);
  const after = await w.config();
  assert.equal(after.treasury, 0n);
  assert.equal(after.buybackPool, c.buybackPool);
  assert.equal(after.rebatePool, c.rebatePool);
  assert.equal(after.stakerPool, c.stakerPool);
  assert.equal(await w.tokens(to), c.treasury);
  await expectError(chain.send([ixs.sweepTreasury(w.admin.publicKey, w.usdc, to, 1n)], [w.admin]), 'BadAmount');
  // and the player balances did not move
  await w.assertBooks('sweep');
});

test('rebate credit turns into $DS at the price the rebate pool paid, for anyone who sends the claim', async () => {
  const c = await w.config();
  assert.ok(c.reserveCost >= c.rebateCredits, 'every credit so far is backed by $DS the pool bought');
  const loser = ten[2].publicKey; // caught in the first round, among others
  const v = await w.vault(loser);
  assert.ok(v.rebateCredit > 0n);
  const [usdc, ds] = rebateClaim(v.rebateCredit, c.dsReserve, c.reserveCost);
  const claimed = await chain.send([ixs.claimRebate(loser)], [w.admin]);
  const ev = eventOf(claimed, 'RebateClaimed');
  assert.deepEqual([ev.usdc, ev.ds, ev.creditLeft], [usdc, ds, 0n]);
  const after = await w.vault(loser);
  assert.equal(after.dsBalance - v.dsBalance, ds);
  assert.equal(after.rebateCredit, 0n);
  const ca = await w.config();
  assert.deepEqual([c.dsReserve - ca.dsReserve, c.reserveCost - ca.reserveCost, c.rebateCredits - ca.rebateCredits], [ds, usdc, usdc]);
  await expectError(chain.send([ixs.claimRebate(loser)], [w.admin]), 'NothingToClaim');
  // the $DS is the player's like any other: they can take it out
  await chain.send([splIxs.createAtaIdempotent(w.admin.publicKey, loser, w.ds, w.dsTokenProgram), ixs.withdrawDs(loser, w.ds, ds, w.dsTokenProgram)], [w.admin, ten[2]]);
  assert.equal(await w.tokens(ata(loser, w.ds, w.dsTokenProgram)), ds);
  await w.assertBooks('rebate claim');
});

test('the admin role moves in two steps; the game server key can be replaced', async () => {
  const next = Keypair.generate();
  const stranger = Keypair.generate();
  await chain.airdrop(next.publicKey, 2);
  await chain.airdrop(stranger.publicKey, 2);
  await expectError(chain.send([ixs.proposeAdmin(stranger.publicKey, stranger.publicKey)], [stranger]), 'NotAdmin');
  await chain.send([ixs.proposeAdmin(w.admin.publicKey, next.publicKey)], [w.admin]);
  await expectError(chain.send([ixs.acceptAdmin(stranger.publicKey)], [stranger]), 'NotPendingAdmin');
  const accepted = await chain.send([ixs.acceptAdmin(next.publicKey)], [next]);
  assert.ok((eventOf(accepted, 'AdminAccepted').admin as PublicKey).equals(next.publicKey));
  await expectError(chain.send([ixs.setAuthority(w.admin.publicKey, stranger.publicKey)], [w.admin]), 'NotAdmin');

  const newServer = Keypair.generate();
  await chain.send([ixs.setAuthority(next.publicKey, newServer.publicKey)], [next]);
  round = await nextRound(2);
  await expectError(w.seat(2, round, [ten[0].publicKey]), /ConstraintHasOne/);
  await chain.send([ixs.setAuthority(next.publicKey, w.authority.publicKey)], [next]);
  await w.seat(2, round, [ten[0].publicKey]);
  await chain.send([ixs.unlockStake(w.authority.publicKey, 2, ten[0].publicKey, round, 0)], [w.authority]);
});

test('the SDK checks the whole deployment over RPC, as anyone would', async () => {
  const report = await checkSolvency(chain.conn);
  assert.ok(report.ok, JSON.stringify(report.checks.filter((c) => !c.ok)));
  assert.equal(report.usdc.surplus, 0n);
  assert.equal(report.ds?.surplus, 0n);
  assert.ok(report.vaults >= w.owners.length);

  const info = await fetchProgramInfo(chain.conn);
  assert.equal(info.hash, executableHash(fs.readFileSync(PROGRAM_SO)), 'deployed bytes are the build');
  assert.ok(info.upgradeAuthority?.equals(w.admin.publicKey));

  const cli = spawnSync(
    path.join(ROOT, 'node_modules/.bin/tsx'),
    ['packages/sdk/src/cli.ts', 'all', '--cluster', 'localnet', '--rpc', chain.rpcUrl, '--so', PROGRAM_SO, '--launch-buy-usdc', String(6n * U)],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /All checks passed/);
  assert.match(cli.stdout, /mint authority revoked/);
  assert.match(cli.stdout, /ok {4}first buyback target is half the launch buy/);
  assert.match(cli.stdout, /ok {4}buyback target is the first target times 0.98 per completed round/);
  assert.ok(info.programData.equals(pda.programData(PROGRAM_ID)));
});
