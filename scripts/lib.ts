// Small helpers shared by the scripts: flags, keypair files, sending, and a
// guard so nothing touches mainnet by accident.

import fs from 'node:fs';
import { Connection, Keypair, Transaction, type TransactionInstruction } from '@solana/web3.js';

export function flags(argv = process.argv.slice(2)): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) out[argv[i].slice(2)] = argv[++i];
    else out[argv[i].slice(2)] = true;
  }
  return out;
}

export function required(f: Record<string, string | true>, name: string): string {
  const v = f[name];
  if (typeof v !== 'string') throw new Error(`missing --${name}`);
  return v;
}

/** A keypair file as written by `solana-keygen new` (kept outside the repository). */
export function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, 'utf8')) as number[]));
}

const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const TESTNET_GENESIS = '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY';

export type ClusterName = 'mainnet-beta' | 'devnet' | 'testnet' | 'local';

/** Which cluster the RPC serves; mainnet only with `--mainnet`. */
export async function clusterOf(conn: Connection, allowMainnet: boolean): Promise<ClusterName> {
  const genesis = await conn.getGenesisHash();
  if (genesis === MAINNET_GENESIS) {
    if (!allowMainnet) throw new Error('this RPC is mainnet: pass --mainnet if that is what you mean');
    return 'mainnet-beta';
  }
  if (genesis === DEVNET_GENESIS) return 'devnet';
  return genesis === TESTNET_GENESIS ? 'testnet' : 'local';
}

/** Sends one transaction signed by `signers` (the first pays) and waits for it. */
export async function send(conn: Connection, ixs: TransactionInstruction[], signers: Keypair[]): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: signers[0].publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
  tx.sign(...signers);
  const signature = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' });
  const res = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  if (res.value.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(res.value.err)}`);
  return signature;
}

export const whole = (units: bigint, decimals = 6) => {
  const s = units.toString().padStart(decimals + 1, '0');
  const int = s.slice(0, -decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
};
