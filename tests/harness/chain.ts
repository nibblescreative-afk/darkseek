// Two ways to run the program in tests, behind one interface:
//  * a real local validator (solana-test-validator): the runtime, SPL Token and
//    RPC exactly as on a cluster; used for every flow that does not need to
//    move the clock;
//  * LiteSVM: the same runtime in process, with a clock tests can move; used
//    for the paths that only open after hours (stale rounds, vesting, auction decay).

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SYSVAR_CLOCK_PUBKEY, SYSVAR_RENT_PUBKEY, Transaction, TransactionInstruction } from '@solana/web3.js';
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  getSignatureFromTransaction,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit';
import { FailedTransactionMetadata, LiteSVM } from 'litesvm';
import { PROGRAM_ID, pda } from '../../packages/sdk/src/index.js';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
export const PROGRAM_SO = path.join(ROOT, 'target/deploy/darkseek_vault.so');

export interface SentTx {
  signature: string;
  logs: string[];
}

export interface ChainAccount {
  data: Buffer;
  owner: PublicKey;
  lamports: number;
}

export interface Chain {
  readonly kind: 'validator' | 'svm';
  /** Signs with every signer (the first pays the fee unless `feePayer` is given) and waits for confirmation. */
  send(ixs: TransactionInstruction[], signers: Keypair[], feePayer?: Keypair): Promise<SentTx>;
  account(key: PublicKey): Promise<ChainAccount | null>;
  airdrop(key: PublicKey, sol: number): Promise<void>;
  /** the chain's clock (unix seconds) */
  now(): Promise<bigint>;
  rent(size: number): Promise<number>;
  stop(): Promise<void>;
}

/** Thrown for a failed transaction; `logs` lets vaultErrorOf name the program error. */
export class TxError extends Error {
  constructor(
    message: string,
    readonly logs: string[],
  ) {
    super(message);
  }
}

const unique = (signers: Keypair[]) => [...new Map(signers.map((s) => [s.publicKey.toBase58(), s])).values()];

// ---------------------------------------------------------------------- validator

function validatorBinary(): string {
  const which = spawnSync('which', ['solana-test-validator'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  return path.join(os.homedir(), '.local/share/solana/install/active_release/bin/solana-test-validator');
}

export class ValidatorChain implements Chain {
  readonly kind = 'validator' as const;
  private constructor(
    readonly conn: Connection,
    private readonly proc: ChildProcess | null,
    private readonly ledger: string,
    readonly rpcUrl: string,
  ) {}

  /**
   * Starts a validator with the program deployed as upgradeable, its upgrade
   * authority `upgradeAuthority` (like a fresh deployment). `basePort` keeps
   * parallel suites apart (it uses basePort to basePort + 60). Runs at the
   * lowest CPU priority.
   */
  static async start(upgradeAuthority: PublicKey, basePort: number): Promise<ValidatorChain> {
    if (!fs.existsSync(PROGRAM_SO)) throw new Error('build the program first: scripts/build-program.sh');
    const ledger = fs.mkdtempSync(path.join(os.tmpdir(), 'darkseek-ledger-'));
    const rpcUrl = `http://127.0.0.1:${basePort}`;
    const args = [
      '-n', '19', validatorBinary(),
      '--reset', '--quiet', '--ledger', ledger, '--bind-address', '127.0.0.1',
      // the websocket listens on rpc + 1, which web3.js expects
      '--rpc-port', String(basePort), '--faucet-port', String(basePort + 2),
      '--gossip-port', String(basePort + 3), '--dynamic-port-range', `${basePort + 10}-${basePort + 60}`,
      '--upgradeable-program', PROGRAM_ID.toBase58(), PROGRAM_SO, upgradeAuthority.toBase58(),
    ];
    const proc = process.env.DS_TEST_RPC ? null : spawn('nice', args, { stdio: 'ignore' });
    const url = process.env.DS_TEST_RPC ?? rpcUrl;
    for (let i = 0; i < 240; i++) {
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }) });
        if ((await r.json()).result === 'ok') break;
      } catch {
        // not up yet
      }
      if (i === 239) throw new Error('validator did not start');
      await new Promise((r) => setTimeout(r, 500));
    }
    return new ValidatorChain(new Connection(url, 'confirmed'), proc, ledger, url);
  }

  async send(ixs: TransactionInstruction[], signers: Keypair[], feePayer = signers[0]): Promise<SentTx> {
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: feePayer.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
    tx.sign(...unique([feePayer, ...signers]));
    let signature: string;
    try {
      signature = await this.conn.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' });
    } catch (err) {
      const e = err as { message?: string; logs?: string[]; transactionLogs?: string[] };
      throw new TxError(String(e.message ?? err), e.transactionLogs ?? e.logs ?? []);
    }
    const res = await this.conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
    const got = await this.conn.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    const logs = got?.meta?.logMessages ?? [];
    if (res.value.err) throw new TxError(`transaction failed: ${JSON.stringify(res.value.err)}`, logs);
    return { signature, logs };
  }

  async account(key: PublicKey): Promise<ChainAccount | null> {
    const info = await this.conn.getAccountInfo(key, 'confirmed');
    return info ? { data: info.data, owner: info.owner, lamports: info.lamports } : null;
  }

  async airdrop(key: PublicKey, sol: number): Promise<void> {
    const sig = await this.conn.requestAirdrop(key, sol * LAMPORTS_PER_SOL);
    const bh = await this.conn.getLatestBlockhash('confirmed');
    await this.conn.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
  }

  async now(): Promise<bigint> {
    const slot = await this.conn.getSlot('confirmed');
    return BigInt((await this.conn.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000));
  }

  rent(size: number): Promise<number> {
    return this.conn.getMinimumBalanceForRentExemption(size);
  }

  async stop(): Promise<void> {
    this.proc?.kill('SIGKILL');
    fs.rmSync(this.ledger, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------- LiteSVM

const UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

function toKit(ix: TransactionInstruction, signers: Map<string, KeyPairSigner>): Instruction {
  return {
    programAddress: address(ix.programId.toBase58()),
    accounts: ix.keys.map((k) => {
      const role = k.isSigner ? (k.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : k.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY;
      const signer = k.isSigner ? signers.get(k.pubkey.toBase58()) : undefined;
      if (k.isSigner && !signer) throw new Error(`missing signer ${k.pubkey.toBase58()}`);
      return signer ? { address: signer.address, role, signer } : { address: address(k.pubkey.toBase58()), role };
    }),
    data: new Uint8Array(ix.data),
  } as Instruction;
}

export class SvmChain implements Chain {
  readonly kind = 'svm' as const;
  readonly svm = new LiteSVM();

  /** Loads the program as upgradeable with `upgradeAuthority`, like `ValidatorChain.start`. */
  constructor(private readonly upgradeAuthority: PublicKey) {
    if (!fs.existsSync(PROGRAM_SO)) throw new Error('build the program first: scripts/build-program.sh');
    this.deploy(PROGRAM_SO);
    this.setTime(BigInt(Math.floor(Date.now() / 1000)));
  }

  /**
   * Puts the program built in `file` at the program's address, with program data
   * just large enough for it; every account the program owns keeps what it holds.
   * This skips the loader, like a program that is already deployed; `upgrade`
   * goes through it.
   */
  deploy(file: string): void {
    this.svm.addProgramFromFile(address(PROGRAM_ID.toBase58()), file);
    // LiteSVM deploys with no upgrade authority; set ours in the program data header
    const pdKey = address(pda.programData(PROGRAM_ID).toBase58());
    const acc = this.svm.getAccount(pdKey);
    if (!acc.exists) throw new Error('program data account missing');
    const data = new Uint8Array(acc.data);
    data[12] = 1;
    data.set(this.upgradeAuthority.toBytes(), 13);
    this.svm.setAccount({ ...acc, data });
  }

  /**
   * Upgrades the program to the build in `file` the way `solana program upgrade`
   * does: the bytes wait in a buffer (as `solana program write-buffer` leaves
   * them), then the upgrade authority's Upgrade instruction has the loader check
   * them and copy them into the program data, which must be large enough to hold
   * them. Not in the slot the program was deployed in; the new code runs from
   * the next slot.
   */
  async upgrade(file: string, authority: Keypair): Promise<SentTx> {
    const buffer = Keypair.generate().publicKey;
    // UpgradeableLoaderState::Buffer { authority_address: Some(authority) }, then the program
    const data = new Uint8Array(Buffer.concat([Buffer.from([1, 0, 0, 0, 1]), authority.publicKey.toBuffer(), fs.readFileSync(file)]));
    this.svm.setAccount({
      address: address(buffer.toBase58()),
      data,
      executable: false,
      lamports: lamports(this.svm.minimumBalanceForRentExemption(BigInt(data.length))),
      programAddress: address(UPGRADEABLE_LOADER.toBase58()),
      space: BigInt(data.length),
    });
    const upgrade = new TransactionInstruction({
      programId: UPGRADEABLE_LOADER,
      keys: [
        { pubkey: pda.programData(PROGRAM_ID), isSigner: false, isWritable: true },
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: true },
        { pubkey: buffer, isSigner: false, isWritable: true },
        // the spill account: the buffer's lamports go back to the authority
        { pubkey: authority.publicKey, isSigner: false, isWritable: true },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: authority.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from([3, 0, 0, 0]), // UpgradeableLoaderInstruction::Upgrade
    });
    return this.send([upgrade], [authority]);
  }

  async send(ixs: TransactionInstruction[], signers: Keypair[], feePayer = signers[0]): Promise<SentTx> {
    const all = unique([feePayer, ...signers]);
    const kit = new Map<string, KeyPairSigner>();
    for (const k of all) kit.set(k.publicKey.toBase58(), await createKeyPairSignerFromBytes(k.secretKey));
    const payer = kit.get(feePayer.publicKey.toBase58())!;
    const message = pipe(
      createTransactionMessage({ version: 'legacy' }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => this.svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
      (m) => appendTransactionMessageInstructions(ixs.map((i) => toKit(i, kit)), m),
    );
    const tx = await signTransactionMessageWithSigners(message);
    const res = this.svm.sendTransaction(tx);
    this.svm.expireBlockhash();
    if (res instanceof FailedTransactionMetadata) throw new TxError(`transaction failed: ${JSON.stringify(res.err(), (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`, res.meta().logs());
    return { signature: getSignatureFromTransaction(tx), logs: res.logs() };
  }

  async account(key: PublicKey): Promise<ChainAccount | null> {
    const acc = this.svm.getAccount(address(key.toBase58()));
    if (!acc.exists) return null;
    return { data: Buffer.from(acc.data), owner: new PublicKey(acc.programAddress), lamports: Number(acc.lamports) };
  }

  async airdrop(key: PublicKey, sol: number): Promise<void> {
    this.svm.airdrop(address(key.toBase58()), lamports(BigInt(sol * LAMPORTS_PER_SOL)));
  }

  async now(): Promise<bigint> {
    return this.svm.getClock().unixTimestamp;
  }

  /** Moves the chain's clock (and the slot, so blockhashes keep changing). */
  setTime(unix: bigint): void {
    const c = this.svm.getClock();
    c.unixTimestamp = unix;
    this.svm.setClock(c);
  }

  async advance(seconds: number): Promise<void> {
    this.setTime((await this.now()) + BigInt(seconds));
    this.svm.warpToSlot(this.svm.getClock().slot + 1n);
  }

  async rent(size: number): Promise<number> {
    return Number(this.svm.minimumBalanceForRentExemption(BigInt(size)));
  }

  async stop(): Promise<void> {}
}
