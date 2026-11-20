// A deployment for tests: test USDC, the config, six rooms, $DS with a fixed
// supply and its reserve, and helpers to seat players and play rounds. Built
// only from the SDK's instruction builders, so the tests also check the SDK.

import assert from 'node:assert/strict';
import { Keypair, PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';
import {
  AUTHORITY_TYPE,
  DS_TOTAL_SUPPLY,
  MINT_SIZE,
  MINT_WITH_POINTER_SIZE,
  PUBLISHED,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  tokenMetadataSize,
  ata,
  decodeConfig,
  decodeMint,
  decodeRoom,
  decodeTokenAccount,
  decodeVault,
  ixs,
  parseEvents,
  pda,
  roomTier,
  solvencyFrom,
  splIxs,
  vaultErrorOf,
  type ConfigAccount,
  type DecodedEvent,
  type DsArgs,
  type RoomAccount,
  type SolvencyReport,
  type VaultAccount,
  type VaultErrorName,
} from '../../packages/sdk/src/index.js';
import type { Chain, SentTx } from './chain.js';

/** One whole USDC or $DS in base units. */
export const U = 1_000_000n;

export const DEFAULT_DS_ARGS: DsArgs = {
  genesisPrice: 100n * U, // 100 $DS per USDC
  floorPrice: U, // never more than 1 USDC per $DS
  duration: 6n * 3600n,
  lot: 1_000n * U,
  minFill: U / 100n,
  buybackTarget: 2n * U, // as if the launch buy had been worth 4 USDC
};

/** Which token program the test $DS lives on: pump.fun uses either. */
export type DsProgram = 'spl' | 'token-2022';

export class World {
  readonly admin: Keypair;
  readonly authority = Keypair.generate();
  readonly usdcMint = Keypair.generate();
  readonly dsMint = Keypair.generate();
  /** the token program of the test $DS */
  dsTokenProgram = TOKEN_PROGRAM_ID;
  /** every wallet that got a vault, for the books */
  readonly owners: PublicKey[] = [];

  /** `admin` must be the program's upgrade authority on `chain`. */
  constructor(
    readonly chain: Chain,
    admin: Keypair,
  ) {
    this.admin = admin;
  }

  get usdc(): PublicKey {
    return this.usdcMint.publicKey;
  }
  get ds(): PublicKey {
    return this.dsMint.publicKey;
  }

  // ---------------------------------------------------------------- reads
  async config(): Promise<ConfigAccount> {
    const a = await this.chain.account(pda.config());
    assert.ok(a, 'config missing');
    return decodeConfig(a.data);
  }
  async vault(owner: PublicKey): Promise<VaultAccount> {
    const a = await this.chain.account(pda.vault(owner));
    assert.ok(a, `no vault for ${owner.toBase58()}`);
    return decodeVault(a.data);
  }
  async room(index: number): Promise<RoomAccount> {
    const a = await this.chain.account(pda.room(index));
    assert.ok(a, `no room ${index}`);
    return decodeRoom(a.data);
  }
  async tokens(account: PublicKey): Promise<bigint> {
    const a = await this.chain.account(account);
    return a ? decodeTokenAccount(a.data).amount : 0n;
  }
  async supply(mint: PublicKey): Promise<bigint> {
    const a = await this.chain.account(mint);
    assert.ok(a);
    return decodeMint(a.data, a.owner).supply;
  }

  // ---------------------------------------------------------------- setup
  async fundKeys(): Promise<void> {
    await this.chain.airdrop(this.admin.publicKey, 100);
    await this.chain.airdrop(this.authority.publicKey, 100);
  }

  /** A classic SPL mint with six decimals and no freeze authority; `admin` may mint. */
  async createMint(mint: Keypair): Promise<void> {
    const rent = await this.chain.rent(MINT_SIZE);
    await this.chain.send(
      [
        SystemProgram.createAccount({ fromPubkey: this.admin.publicKey, newAccountPubkey: mint.publicKey, lamports: rent, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
        splIxs.initializeMint2(mint.publicKey, 6, this.admin.publicKey),
      ],
      [this.admin, mint],
    );
  }

  async mintTo(mint: PublicKey, owner: PublicKey, amount: bigint): Promise<void> {
    await this.chain.send([splIxs.createAtaIdempotent(this.admin.publicKey, owner, mint), splIxs.mintTo(mint, ata(owner, mint), this.admin.publicKey, amount)], [this.admin]);
  }

  initializeIx(signer = this.admin.publicKey): TransactionInstruction {
    return ixs.initialize(signer, this.usdc, {
      authority: this.authority.publicKey,
      stakes: [...PUBLISHED.stakes] as [bigint, bigint, bigint, bigint],
      feeBps: PUBLISHED.feeBps,
      split: { ...PUBLISHED.split },
    });
  }

  async createRooms(): Promise<void> {
    await this.chain.send(
      Array.from({ length: 6 }, (_, i) => ixs.initRoom(this.admin.publicKey, i + 1, roomTier(i + 1))),
      [this.admin],
    );
  }

  /**
   * A test $DS shaped like a pump.fun token: one billion with six decimals,
   * no freeze authority, the mint authority removed after the single mint. On
   * Token 2022 it carries its metadata in the mint, as pump.fun's do. The
   * whole supply goes to the admin, who hands it out in tests.
   */
  async createDs(program: DsProgram = 'spl'): Promise<void> {
    this.dsTokenProgram = await this.createPumpLikeMint(this.dsMint, program);
  }

  /** Any token shaped like a pump.fun mint, the whole supply to the admin; returns its token program. */
  async createPumpLikeMint(mintKey: Keypair, program: DsProgram): Promise<PublicKey> {
    const mint = mintKey.publicKey;
    const p = program === 'spl' ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
    if (program === 'spl') {
      await this.createMint(mintKey);
    } else {
      const meta = { name: 'DarkSeek test', symbol: 'DSTEST', uri: 'https://example.invalid/ds.json' };
      const rent = await this.chain.rent(MINT_WITH_POINTER_SIZE + tokenMetadataSize(meta));
      await this.chain.send(
        [
          SystemProgram.createAccount({ fromPubkey: this.admin.publicKey, newAccountPubkey: mint, lamports: rent, space: MINT_WITH_POINTER_SIZE, programId: p }),
          splIxs.initializeMetadataPointer(mint, null, mint),
          splIxs.initializeMint2(mint, 6, this.admin.publicKey, p),
          splIxs.initializeTokenMetadata(mint, this.admin.publicKey, this.admin.publicKey, meta),
        ],
        [this.admin, mintKey],
      );
    }
    await this.chain.send(
      [
        splIxs.createAtaIdempotent(this.admin.publicKey, this.admin.publicKey, mint, p),
        splIxs.mintTo(mint, ata(this.admin.publicKey, mint, p), this.admin.publicKey, DS_TOTAL_SUPPLY, p),
        splIxs.setAuthority(mint, this.admin.publicKey, AUTHORITY_TYPE.MintTokens, null, p),
      ],
      [this.admin],
    );
    return p;
  }

  /** Sends test $DS from the admin to `owner`'s token account. */
  async giveDs(owner: PublicKey, amount: bigint): Promise<void> {
    const p = this.dsTokenProgram;
    await this.chain.send(
      [splIxs.createAtaIdempotent(this.admin.publicKey, owner, this.ds, p), splIxs.transferChecked(ata(this.admin.publicKey, this.ds, p), this.ds, ata(owner, this.ds, p), this.admin.publicKey, amount, 6, p)],
      [this.admin],
    );
  }

  /** Everything a deployment has: config, rooms and $DS recorded with its buyback target. */
  async setup(o: { ds?: DsArgs; dsProgram?: DsProgram } = {}): Promise<this> {
    await this.fundKeys();
    await this.createMint(this.usdcMint);
    await this.chain.send([this.initializeIx()], [this.admin]);
    await this.createRooms();
    await this.createDs(o.dsProgram);
    await this.chain.send([ixs.initDs(this.admin.publicKey, this.ds, o.ds ?? DEFAULT_DS_ARGS, this.dsTokenProgram)], [this.admin]);
    return this;
  }

  // ---------------------------------------------------------------- players
  /** A wallet with a vault holding `usdc`, and a game session (cap per day) unless `session` is false. */
  async player(usdc: bigint, o: { cap?: bigint; session?: boolean; ds?: bigint } = {}): Promise<Keypair> {
    const p = Keypair.generate();
    const list: TransactionInstruction[] = [
      splIxs.createAtaIdempotent(this.admin.publicKey, p.publicKey, this.usdc),
      splIxs.mintTo(this.usdc, ata(p.publicKey, this.usdc), this.admin.publicKey, usdc),
      ixs.openVault(this.admin.publicKey, p.publicKey),
      ixs.deposit(p.publicKey, this.usdc, p.publicKey, usdc),
    ];
    if (o.session !== false) {
      const now = await this.chain.now();
      list.push(ixs.setSession(p.publicKey, o.cap ?? 1_000n * U, now + 30n * 86_400n));
    }
    await this.chain.send(list, [this.admin, p]);
    if (o.ds) await this.giveDs(p.publicKey, o.ds);
    this.owners.push(p.publicKey);
    return p;
  }

  async players(n: number, usdc: bigint, o: { cap?: bigint } = {}): Promise<Keypair[]> {
    const out: Keypair[] = [];
    for (let i = 0; i < n; i++) out.push(await this.player(usdc, o));
    return out;
  }

  // ---------------------------------------------------------------- rounds (as the game server)
  /** Locks the stakes of `seated` (slot order) in one transaction. */
  seat(room: number, round: bigint, seated: PublicKey[], firstSlot = 0): Promise<SentTx> {
    return this.chain.send(
      seated.map((o, i) => ixs.lockStake(this.authority.publicKey, room, o, round, firstSlot + i)),
      [this.authority],
    );
  }
  start(room: number, round: bigint): Promise<SentTx> {
    return this.chain.send([ixs.startRound(this.authority.publicKey, room, round)], [this.authority]);
  }
  settle(room: number, round: bigint, outcomes: number[], seated: PublicKey[]): Promise<SentTx> {
    return this.chain.send([ixs.settleRound(this.authority.publicKey, room, round, outcomes, seated)], [this.authority]);
  }
  /** Seats ten players, starts and settles; returns the start and settle transactions. */
  async play(room: number, round: bigint, seated: PublicKey[], outcomes: number[]): Promise<{ started: SentTx; settled: SentTx }> {
    await this.seat(room, round, seated);
    const started = await this.start(room, round);
    const settled = await this.settle(room, round, outcomes, seated);
    return { started, settled };
  }

  // ---------------------------------------------------------------- books
  /** Solvency of everything this world created (the SDK rules on the live accounts). */
  async books(): Promise<SolvencyReport> {
    const config = await this.config();
    const vaults = await Promise.all(this.owners.map((o) => this.vault(o)));
    const rooms = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => this.room(i)));
    return solvencyFrom({
      config,
      custody: await this.tokens(config.custody),
      dsCustody: config.dsMint.equals(PublicKey.default) ? null : await this.tokens(config.dsCustody),
      vaults,
      rooms,
    });
  }

  /** Custody holds exactly what the program owes, after every step. */
  async assertBooks(label: string): Promise<void> {
    const r = await this.books();
    assert.ok(r.ok, `${label}: ${JSON.stringify(r.checks.filter((c) => !c.ok && !c.warn))}`);
    assert.equal(r.usdc.surplus, 0n, `${label}: USDC custody equals what is owed`);
    if (r.ds) assert.equal(r.ds.surplus, 0n, `${label}: $DS custody equals what is owed`);
  }
}

/** Fails unless `p` rejects with the named program error (or logs matching a pattern). */
export async function expectError(p: Promise<unknown>, name: VaultErrorName | RegExp): Promise<void> {
  try {
    await p;
  } catch (err) {
    const e = err as { message?: string; logs?: string[] };
    if (name instanceof RegExp) {
      assert.match(`${e.message} ${JSON.stringify(e.logs ?? [])}`, name);
      return;
    }
    assert.equal(vaultErrorOf(err), name, `${String(e.message).slice(0, 200)} ${JSON.stringify(e.logs ?? []).slice(0, 600)}`);
    return;
  }
  assert.fail(`expected ${String(name)}`);
}

export const eventsOf = (tx: SentTx): DecodedEvent[] => parseEvents(tx.logs);
export const eventOf = (tx: SentTx, name: string): Record<string, unknown> => {
  const ev = eventsOf(tx).find((e) => e.name === name);
  assert.ok(ev, `no ${name} event in ${JSON.stringify(tx.logs)}`);
  return ev.data;
};
