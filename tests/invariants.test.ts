// Stateful fuzzing of the vault program in LiteSVM. Each seed plays a random
// sequence of everything players, the game server, the admin and strangers can
// do: deposits and withdrawals, shop and P2P payments, seats taken and left,
// rounds started, settled with random outcomes, cancelled, or left until anyone
// may unwind them, $DS deposited, staked, unstaked and withdrawn, rewards and
// rebates claimed, $DS sold into the buyback auction, the treasury swept, and
// the clock moved. After every step:
//
//   * the books balance to the base unit (World.assertBooks): USDC custody
//     equals vault balances + room pots + treasury + the three pools, and $DS
//     custody equals the reserve + every vault's free and staked $DS;
//   * a settlement paid every seat exactly what the published rules say
//     (payoutsFor), and released exactly the stakes it held;
//   * a refused step changed nothing.
//
// Run:        scripts/build-program.sh && npx tsx --test tests/invariants.test.ts
// Longer:     FUZZ_SEEDS=40 FUZZ_STEPS=600 npx tsx --test tests/invariants.test.ts
// One seed:   FUZZ_SEED=<the seed a failure printed> npx tsx --test tests/invariants.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, type PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { STALE_AFTER_SECS, STATUS, SURVIVED, ata, ixs, payoutsFor, splIxs, type RoomAccount, type SolvencyReport, LEAVE_AFTER_SECS } from '../packages/sdk/src/index.js';
import { SvmChain } from './harness/chain.js';
import { DEFAULT_DS_ARGS, U, World, type DsProgram } from './harness/world.js';

const SEEDS = process.env.FUZZ_SEED ? [Number(process.env.FUZZ_SEED)] : Array.from({ length: Number(process.env.FUZZ_SEEDS ?? 6) }, (_, i) => 1_000 + i);
const STEPS = Number(process.env.FUZZ_STEPS ?? 160);
const PLAYERS = 20;
const DS_HOLDERS = 5;
const ROOMS = [1, 2, 3, 4, 5, 6];
/** keeps every session (30 days from the start) alive for the whole run */
const MAX_CLOCK_MOVE = 20 * 86_400;

/** mulberry32: small, fast, and the same sequence everywhere */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (n: number): number => Math.floor(next() * n);
  return {
    int,
    chance: (p: number): boolean => next() < p,
    pick: <T>(xs: readonly T[]): T => xs[int(xs.length)],
    shuffle: <T>(xs: readonly T[]): T[] => {
      const out = [...xs];
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(i + 1);
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    /** 1..max base units: mostly small, sometimes exactly 1 or all of it */
    amount: (max: bigint): bigint => {
      if (max <= 0n) return 0n;
      const r = next();
      if (r < 0.1) return max;
      if (r < 0.2) return 1n;
      return 1n + (BigInt(int(1 << 30)) * max) / BigInt(1 << 30);
    },
  };
}
type Rng = ReturnType<typeof rng>;

/** A step: what it tries, and the transaction(s) that do it. `check` runs only if it went through. */
interface Step {
  name: string;
  run: () => Promise<unknown>;
  check?: () => Promise<void>;
}

const tally = new Map<string, { ok: number; refused: number }>();
const count = (name: string, ok: boolean) => {
  const t = tally.get(name) ?? { ok: 0, refused: 0 };
  if (ok) t.ok++;
  else t.refused++;
  tally.set(name, t);
};
const json = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

class Fuzz {
  players: Keypair[] = [];
  stranger = Keypair.generate();
  clockMoved = 0;

  constructor(
    readonly w: World,
    readonly chain: SvmChain,
    readonly r: Rng,
  ) {}

  get dsProgram() {
    return this.w.dsTokenProgram;
  }
  /** Players sign; the admin pays the fees (players hold no SOL). */
  send(list: TransactionInstruction[], ...signers: Keypair[]) {
    return this.chain.send(list, [this.w.admin, ...signers]);
  }

  async setup(): Promise<void> {
    for (let i = 0; i < PLAYERS; i++) {
      const usdc = BigInt(10 + this.r.int(70)) * U;
      this.players.push(await this.w.player(usdc, { ds: i < DS_HOLDERS ? BigInt(1 + this.r.int(50_000)) * U : undefined }));
    }
    // the $DS holders start with part of it in their vaults, so staking is reachable from the first step
    for (const p of this.players.slice(0, DS_HOLDERS)) {
      const held = await this.w.tokens(ata(p.publicKey, this.w.ds, this.dsProgram));
      await this.send([ixs.depositDs(p.publicKey, this.w.ds, p.publicKey, held / 2n, this.dsProgram)], p);
    }
    await this.chain.airdrop(this.stranger.publicKey, 5);
    await this.w.chain.send([splIxs.createAtaIdempotent(this.w.admin.publicKey, this.w.admin.publicKey, this.w.usdc)], [this.w.admin]);
  }

  // ---------------------------------------------------------------- the menu
  async next(): Promise<Step> {
    const roll = this.r.int(100);
    if (roll < 40) return this.roundStep();
    if (roll < 46) return this.deposit();
    if (roll < 51) return this.withdraw();
    if (roll < 54) return this.charge();
    if (roll < 59) return this.pay();
    if (roll < 63) return this.depositDs();
    if (roll < 67) return this.stake();
    if (roll < 70) return this.unstake();
    if (roll < 72) return this.withdrawDs();
    if (roll < 77) return this.claimRewards();
    if (roll < 82) return this.claimRebate();
    if (roll < 88) return this.sell();
    if (roll < 91) return this.sweep();
    if (roll < 94) return this.session();
    return this.tick();
  }

  // ---------------------------------------------------------------- rooms
  /** Moves one room on: seat players, or start, settle, cancel, or abandon its round. */
  async roundStep(): Promise<Step> {
    const index = this.r.pick(ROOMS);
    const room = await this.w.room(index);
    const seated = room.seats.filter((s) => !isEmpty(s.owner));
    if (room.status === STATUS.LIVE) {
      const roll = this.r.int(100);
      if (roll < 82) return this.settle(index, room);
      if (roll < 92) return this.cancel(index, room);
      return this.abandon(index, room);
    }
    if (room.status === STATUS.OPEN && seated.length === 10 && this.r.chance(0.85)) return this.start(index, room);
    if (room.status === STATUS.OPEN && seated.length > 0) {
      const roll = this.r.int(100);
      if (roll < 8) return this.leave(index, room);
      if (roll < 12) return this.ownerLeaves(index, room);
      if (roll < 15) return this.cancel(index, room);
      if (roll < 17) return this.abandon(index, room);
      if (roll < 19) return this.start(index, room); // not full: must be refused
    }
    if (this.r.chance(0.03)) return this.skipRound(index, room); // must be refused
    return this.seat(index, room);
  }

  /** The seat's owner leaves on their own: refused until the lobby has formed for 30 minutes (v0.4.0). */
  async ownerLeaves(index: number, room: RoomAccount): Promise<Step> {
    const slot = this.r.pick([...room.seats.keys()].filter((i) => !isEmpty(room.seats[i].owner)));
    const owner = this.players.find((p) => p.publicKey.equals(room.seats[slot].owner));
    if (!owner) return { name: 'owner leaves (not ours)', run: async () => undefined };
    const wait = this.r.chance(0.6) && this.clockMoved + LEAVE_AFTER_SECS + 60 <= MAX_CLOCK_MOVE;
    return {
      name: wait ? 'owner leaves' : 'owner leaves (no wait)',
      run: async () => {
        if (wait) await this.move(LEAVE_AFTER_SECS + 60);
        return this.send([ixs.leaveSeat(owner.publicKey, index, room.round, slot)], owner);
      },
    };
  }

  /** A round number past the next one: always refused, so no room can be pushed out of rounds (v0.4.0). */
  skipRound(index: number, room: RoomAccount): Step {
    const round = room.round + 2n + BigInt(this.r.int(1_000));
    const who = this.r.pick(this.players);
    return { name: 'skip a round', run: () => this.chain.send([ixs.lockStake(this.w.authority.publicKey, index, who.publicKey, round, this.r.int(10))], [this.w.authority]) };
  }

  async seat(index: number, room: RoomAccount): Promise<Step> {
    const round = room.status === STATUS.SETTLED ? room.round + 1n : room.round;
    const config = await this.w.config();
    const taken = new Set(room.seats.filter((s) => !isEmpty(s.owner)).map((s) => s.owner.toBase58()));
    const free = this.r.shuffle([...room.seats.keys()].filter((i) => isEmpty(room.seats[i].owner)));
    const list: TransactionInstruction[] = [];
    for (const slot of free.slice(0, 1 + this.r.int(5))) {
      const stake = config.stakes[room.tier * 2 + (slot < 2 ? 1 : 0)];
      const who = await this.someone(async (p) => !taken.has(p.publicKey.toBase58()) && (this.r.chance(0.05) || (await this.w.vault(p.publicKey)).balance >= stake));
      if (!who) break;
      taken.add(who.publicKey.toBase58());
      list.push(ixs.lockStake(this.w.authority.publicKey, index, who.publicKey, round, slot));
    }
    if (!list.length) return { name: 'seat (nobody fits)', run: async () => undefined };
    return { name: 'seat', run: () => this.chain.send(list, [this.w.authority]) };
  }

  async leave(index: number, room: RoomAccount): Promise<Step> {
    const slot = this.r.pick([...room.seats.keys()].filter((i) => !isEmpty(room.seats[i].owner)));
    return { name: 'leave', run: () => this.chain.send([ixs.unlockStake(this.w.authority.publicKey, index, room.seats[slot].owner, room.round, slot)], [this.w.authority]) };
  }

  start(index: number, room: RoomAccount): Step {
    return { name: 'start', run: () => this.chain.send([ixs.startRound(this.w.authority.publicKey, index, room.round)], [this.w.authority]) };
  }

  /** Random outcomes (a clean sweep for the Seekers now and then); checks every payout against the published rules. */
  async settle(index: number, room: RoomAccount): Promise<Step> {
    const sweep = this.r.chance(0.2);
    const outcomes = Array.from({ length: 8 }, () => (sweep ? this.r.int(2) : this.r.pick([SURVIVED, SURVIVED, 0, 1])));
    if (this.r.chance(0.04)) outcomes[this.r.int(8)] = 2 + this.r.int(5); // not a Seeker slot: must be refused
    const owners = room.seats.map((s) => s.owner);
    const config = await this.w.config();
    const before = await Promise.all(owners.map((o) => this.w.vault(o)));
    return {
      name: 'settle',
      run: () => this.chain.send([ixs.settleRound(this.w.authority.publicKey, index, room.round, outcomes, owners)], [this.w.authority]),
      check: async () => {
        const paid = payoutsFor(config.stakes, config.feeBps, room.tier, outcomes);
        const after = await Promise.all(owners.map((o) => this.w.vault(o)));
        for (let slot = 0; slot < 10; slot++) {
          assert.equal(after[slot].balance - before[slot].balance, paid[slot], `slot ${slot} paid what the rules say`);
          assert.equal(before[slot].locked - after[slot].locked, room.seats[slot].stake, `slot ${slot} stake released`);
        }
        const settled = await this.w.room(index);
        assert.equal(settled.status, STATUS.SETTLED);
        assert.equal(settled.pot, 0n, 'a settled room holds nothing');
      },
    };
  }

  cancel(index: number, room: RoomAccount): Step {
    const owners = room.seats.filter((s) => !isEmpty(s.owner)).map((s) => s.owner);
    return { name: 'cancel', run: () => this.chain.send([ixs.cancelRound(this.w.authority.publicKey, index, room.round, owners)], [this.w.authority]) };
  }

  /** The game server goes quiet: after two hours anyone may unwind the round (and before that nobody may). */
  async abandon(index: number, room: RoomAccount): Promise<Step> {
    const owners = room.seats.filter((s) => !isEmpty(s.owner)).map((s) => s.owner);
    const early = this.r.chance(0.25) || this.clockMoved + STALE_AFTER_SECS + 60 > MAX_CLOCK_MOVE;
    return {
      name: early ? 'abandon (no wait)' : 'abandon',
      run: async () => {
        if (!early) await this.move(STALE_AFTER_SECS + 60);
        return this.chain.send([ixs.abortStaleRound(this.stranger.publicKey, index, room.round, owners)], [this.stranger]);
      },
    };
  }

  // ---------------------------------------------------------------- USDC
  async deposit(): Promise<Step> {
    const p = this.r.pick(this.players);
    const amount = this.r.amount(20n * U);
    return {
      name: 'deposit',
      run: () => this.send([splIxs.mintTo(this.w.usdc, ata(p.publicKey, this.w.usdc), this.w.admin.publicKey, amount), ixs.deposit(p.publicKey, this.w.usdc, p.publicKey, amount)], p),
    };
  }
  async withdraw(): Promise<Step> {
    const p = this.r.pick(this.players);
    const v = await this.w.vault(p.publicKey);
    const amount = this.r.chance(0.15) ? v.balance + 1n : this.r.amount(v.balance) || 1n;
    return { name: 'withdraw', run: () => this.send([ixs.withdraw(p.publicKey, this.w.usdc, amount)], p) };
  }
  async charge(): Promise<Step> {
    const p = this.r.pick(this.players);
    const amount = this.r.amount((await this.w.vault(p.publicKey)).balance) || 1n;
    return { name: 'charge', run: () => this.send([ixs.charge(p.publicKey, amount)], p) };
  }
  async pay(): Promise<Step> {
    const [a, b] = this.r.shuffle(this.players);
    const amount = this.r.chance(0.1) ? (await this.w.vault(a.publicKey)).balance + 1n : this.r.amount((await this.w.vault(a.publicKey)).balance) || 1n;
    return { name: 'pay', run: () => this.send([ixs.pay(a.publicKey, b.publicKey, amount)], a) };
  }
  async sweep(): Promise<Step> {
    const amount = this.r.amount((await this.w.config()).treasury) || 1n;
    return { name: 'sweep treasury', run: () => this.chain.send([ixs.sweepTreasury(this.w.admin.publicKey, this.w.usdc, ata(this.w.admin.publicKey, this.w.usdc), amount)], [this.w.admin]) };
  }
  async session(): Promise<Step> {
    const p = this.r.pick(this.players);
    const now = await this.chain.now();
    return { name: 'session', run: () => this.send([ixs.setSession(p.publicKey, BigInt(1 + this.r.int(1_000)) * U, now + 30n * 86_400n)], p) };
  }

  // ---------------------------------------------------------------- $DS
  holder(): Keypair {
    return this.players[this.r.int(DS_HOLDERS)];
  }
  async depositDs(): Promise<Step> {
    const p = this.holder();
    const held = await this.w.tokens(ata(p.publicKey, this.w.ds, this.dsProgram));
    const amount = this.r.amount(held) || 1n;
    return { name: 'deposit $DS', run: () => this.send([ixs.depositDs(p.publicKey, this.w.ds, p.publicKey, amount, this.dsProgram)], p) };
  }
  async withdrawDs(): Promise<Step> {
    const p = this.holder();
    const amount = this.r.amount((await this.w.vault(p.publicKey)).dsBalance) || 1n;
    return { name: 'withdraw $DS', run: () => this.send([ixs.withdrawDs(p.publicKey, this.w.ds, amount, this.dsProgram)], p) };
  }
  async stake(): Promise<Step> {
    const p = this.holder();
    const amount = this.r.amount((await this.w.vault(p.publicKey)).dsBalance) || 1n;
    return { name: 'stake $DS', run: () => this.send([ixs.stakeDs(p.publicKey, amount)], p) };
  }
  async unstake(): Promise<Step> {
    const p = this.holder();
    const amount = this.r.amount((await this.w.vault(p.publicKey)).dsStaked) || 1n;
    return { name: 'unstake $DS', run: () => this.send([ixs.unstakeDs(p.publicKey, amount)], p) };
  }
  async claimRewards(): Promise<Step> {
    const p = this.r.pick(this.players);
    return { name: 'claim rewards', run: () => this.chain.send([ixs.claimRewards(p.publicKey)], [this.stranger]) };
  }
  async claimRebate(): Promise<Step> {
    const p = this.r.pick(this.players);
    return { name: 'claim rebate', run: () => this.chain.send([ixs.claimRebate(p.publicKey)], [this.stranger]) };
  }
  /** Sells $DS into the buyback auction, which pays from the buyback and rebate pools. */
  async sell(): Promise<Step> {
    const p = this.holder();
    const held = await this.w.tokens(ata(p.publicKey, this.w.ds, this.dsProgram));
    const amount = this.r.amount(held / 10n) || 1n;
    return { name: 'sell $DS', run: () => this.send([ixs.sellDs(p.publicKey, this.w.usdc, this.w.ds, amount, 0n, this.dsProgram)], p) };
  }

  // ---------------------------------------------------------------- time
  async move(seconds: number): Promise<void> {
    this.clockMoved += seconds;
    await this.chain.advance(seconds);
  }
  tick(): Step {
    const seconds = 1 + this.r.int(3_600);
    const ok = this.clockMoved + seconds <= MAX_CLOCK_MOVE;
    return { name: 'clock', run: async () => (ok ? this.move(seconds) : undefined) };
  }

  /** A random player passing `fit`, or null after a few tries. */
  async someone(fit: (p: Keypair) => Promise<boolean>): Promise<Keypair | null> {
    for (const p of this.r.shuffle(this.players).slice(0, 8)) if (await fit(p)) return p;
    return null;
  }
}

const isEmpty = (k: PublicKey) => k.toBytes().every((b) => b === 0);

for (const seed of SEEDS) {
  test(`seed ${seed}: ${STEPS} random steps, books balanced after every one`, async () => {
    const admin = Keypair.generate();
    const chain = new SvmChain(admin.publicKey);
    const dsProgram: DsProgram = seed % 2 === 0 ? 'spl' : 'token-2022';
    // a small first buyback target so the auction opens within a run
    const w = await new World(chain, admin).setup({ ds: { ...DEFAULT_DS_ARGS, buybackTarget: U / 4n }, dsProgram });
    const fuzz = new Fuzz(w, chain, rng(seed));
    await fuzz.setup();
    await w.assertBooks(`seed ${seed} after setup`);

    for (let i = 0; i < STEPS; i++) {
      const step = await fuzz.next();
      const where = `seed ${seed} step ${i} (${step.name})`;
      const before: SolvencyReport = await w.books();
      let ok = true;
      try {
        await step.run();
      } catch {
        ok = false;
      }
      count(step.name, ok);
      if (ok) {
        await step.check?.();
        await w.assertBooks(where);
      } else {
        // a refused transaction is all or nothing: not one base unit moved
        assert.equal(json(await w.books()), json(before), `${where}: refused, and nothing changed`);
      }
    }
  });
}

test('the runs covered every kind of step', () => {
  const rows = [...tally.entries()].sort(([a], [b]) => a.localeCompare(b));
  console.log(rows.map(([name, t]) => `${name.padEnd(20)} ${String(t.ok).padStart(5)} done ${String(t.refused).padStart(5)} refused`).join('\n'));
  const done = (name: string) => tally.get(name)?.ok ?? 0;
  for (const name of ['seat', 'start', 'settle', 'deposit', 'withdraw', 'pay', 'charge', 'deposit $DS', 'stake $DS', 'claim rewards']) {
    assert.ok(done(name) > 0, `no successful "${name}" in any run: the fuzzer is not reaching it`);
  }
});
