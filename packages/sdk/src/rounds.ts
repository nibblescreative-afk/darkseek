// Checks the game's signed round results (GET <site>/api/rounds) from the outside.
//
// For every record: the signature (a Solana off-chain message signed by the game
// server key, which must be the program's config.authority), the fair deal (the
// server's seed against the commit shown before anyone sat down, the round seed from
// that seed and every seat's nonce, every spawn and role redrawn from the round seed),
// the outcome against the captures, and the settle transaction onchain: same round,
// same outcome bytes, the same ten vaults, and it succeeded.
//
// The deal and the record format are specified in docs/fairness.md. This file is Node
// only (it verifies ed25519 with node:crypto); the CLI uses it, it is not in the index.

import { createPublicKey, verify as edVerify } from 'node:crypto';
import { Connection, PublicKey } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { INSTRUCTION_DISCRIMINATORS } from './instructions.js';
import { pda } from './pda.js';
import type { Check, Report } from './verify.js';

// ------------------------------------------------------------------ the deal (same as the game)
const HEX64 = /^[0-9a-f]{64}$/;
export type Disguise = 'stalagmite' | 'crate';
export interface RoundDeal {
  spawns: Record<string, number>;
  healer: string | null;
  jester: string | null;
  detective: string | null;
  mimic: Record<string, Disguise>;
}

export function commitOf(serverSeed: string): string {
  if (!HEX64.test(serverSeed)) throw new Error('bad server seed');
  return bytesToHex(sha256(hexToBytes(serverSeed)));
}

export const cleanNonce = (raw: unknown): string => (typeof raw === 'string' && /^[0-9a-f]{0,64}$/.test(raw) ? raw : '');

export function roundSeedOf(room: string, round: number, serverSeed: string, nonces: string[]): string {
  if (!HEX64.test(serverSeed)) throw new Error('bad server seed');
  return bytesToHex(sha256(concatBytes(utf8ToBytes(`DarkSeek round seed v1|${room}|${round}|`), hexToBytes(serverSeed), utf8ToBytes(nonces.map(cleanNonce).join('|')))));
}

export function draw(seed: Uint8Array, label: string, i: number, n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > 0xffff_ffff) throw new Error('bad range');
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  for (let k = 0; ; k++) {
    const h = sha256(concatBytes(seed, utf8ToBytes(`${label}:${i}:${k}`)));
    const v = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
    if (v < limit) return v % n;
  }
}

export function dealRound(roundSeed: string, hiders: string[], spawnCount: number): RoundDeal {
  if (!HEX64.test(roundSeed)) throw new Error('bad round seed');
  const seed = hexToBytes(roundSeed);
  const order = Array.from({ length: spawnCount }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = draw(seed, 'spawn', i, i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const spawns: Record<string, number> = {};
  hiders.forEach((id, i) => (spawns[id] = order[i % Math.max(1, order.length)] ?? 0));
  const pool = [...hiders];
  const pick = (label: string): string | null => (pool.length ? pool.splice(draw(seed, label, 0, pool.length), 1)[0] : null);
  const healer = pick('healer');
  const jester = pick('jester');
  const detective = pick('detective');
  const mimic: Record<string, Disguise> = {};
  hiders.forEach((id, i) => (mimic[id] = draw(seed, 'mimic', i, 2) === 1 ? 'crate' : 'stalagmite'));
  return { spawns, healer, jester, detective, mimic };
}

// ------------------------------------------------------------------ the record
export interface RoundRecord {
  v: 1;
  game: 'DarkSeek';
  room: string;
  tier: string;
  round: number;
  startedAt: string;
  endedAt: string;
  network: { cluster: string; program: string; roomIndex: number; chainRound: string | null; settles: boolean } | null;
  fairness: { commit: string; serverSeed: string; nonces: string[]; roundSeed: string; spawnCount: number; deal: RoundDeal };
  seats: { seat: string; role: 'SEEKER' | 'HIDER'; character: string; wallet: string | null; slot: number | null; staked: boolean }[];
  catches: { ms: number; seeker: string | null; hider: string }[];
  outcome: { reason: string; slots: number[]; survivors: string[] };
}

export interface SignedRoundRecord {
  record: RoundRecord;
  digest: string;
  message: string;
  signer: string | null;
  signature: string | null;
  settleTx?: string | null;
}

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isSafeInteger(v)) throw new Error('records hold whole numbers only');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

export const recordDigest = (r: RoundRecord): string => bytesToHex(sha256(utf8ToBytes(canonicalJson(r))));
export const recordMessage = (r: RoundRecord, digest: string): string => `DarkSeek round result v1 ${r.room} ${r.round} ${digest}`;

/** The bytes `solana sign-offchain-message` signs: 0xFF "solana offchain", version 0, format 0, length (u16 LE), message. */
export function offchainMessageBytes(message: string): Uint8Array {
  if (!/^[\x20-\x7e]*$/.test(message) || message.length > 1212) throw new Error('not a printable ASCII off-chain message of at most 1212 bytes');
  const body = utf8ToBytes(message);
  return concatBytes(new Uint8Array([0xff]), utf8ToBytes('solana offchain'), new Uint8Array([0, 0, body.length & 0xff, body.length >> 8]), body);
}

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

export function verifyEd25519(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(publicKey)]), format: 'der', type: 'spki' });
    return edVerify(null, Buffer.from(message), key, Buffer.from(signature));
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ checks
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error('not base58');
    n = n * 58n + BigInt(i);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of s) {
    if (c !== '1') break;
    out.unshift(0);
  }
  return new Uint8Array(out);
}

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const short = (s: string) => (s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s);

/** Everything about one record that needs no chain: the signature, the deal, the outcome. */
export function checkRecordOffline(s: SignedRoundRecord, gameServerKey: string | null): string[] {
  const p: string[] = [];
  const r = s.record;
  let digest = '';
  try {
    digest = recordDigest(r);
  } catch {
    p.push('the record is not well formed');
  }
  if (digest && digest !== s.digest) p.push('the record does not match its digest');
  if (digest && s.message !== recordMessage(r, digest)) p.push('the signed line does not name this record');
  if (!s.signer || !s.signature) p.push('not signed');
  else {
    if (gameServerKey && s.signer !== gameServerKey) p.push(`signed by ${short(s.signer)}, not the game server key ${short(gameServerKey)}`);
    let ok = false;
    try {
      ok = verifyEd25519(base58Decode(s.signature), offchainMessageBytes(s.message), base58Decode(s.signer));
    } catch {
      ok = false;
    }
    if (!ok) p.push('the signature does not hold');
  }
  // the deal
  const f = r.fairness;
  try {
    if (commitOf(f.serverSeed) !== f.commit) p.push('the server seed does not match its commit');
    if (roundSeedOf(r.room, r.round, f.serverSeed, f.nonces) !== f.roundSeed) p.push('the round seed does not follow from the server seed and the nonces');
    const hiders = r.seats.filter((x) => x.role === 'HIDER').map((x) => x.seat);
    if (!same(dealRound(f.roundSeed, hiders, f.spawnCount), f.deal)) p.push('the spawns and roles are not the ones the round seed deals');
  } catch (err) {
    p.push(`the deal cannot be checked: ${(err as Error).message}`);
  }
  // the outcome against the captures
  const slotOf = new Map(r.seats.map((x) => [x.seat, x.slot]));
  const caught = new Map(r.catches.map((c) => [c.hider, c.seeker]));
  for (const h of r.seats.filter((x) => x.role === 'HIDER')) {
    if (h.slot === null || h.slot < 2 || h.slot > 9) continue;
    const got = r.outcome.slots[h.slot - 2];
    const survived = r.outcome.survivors.includes(h.seat);
    if (survived === caught.has(h.seat)) p.push(`${h.seat} is both caught and a survivor, or neither`);
    const want = survived ? 255 : (slotOf.get(caught.get(h.seat) ?? '') ?? 0);
    if (got !== want) p.push(`the outcome for ${h.seat} (slot ${h.slot}) is ${got}, the captures say ${want}`);
  }
  return p;
}

const SETTLE = INSTRUCTION_DISCRIMINATORS.settle_round;

/** The settle transaction must be this round's: same program, room, round, outcome bytes and the ten vaults, and it succeeded. */
export async function checkSettlement(conn: Connection, programId: PublicKey, s: SignedRoundRecord): Promise<{ problems: string[]; tx: string | null; pending: boolean }> {
  const r = s.record;
  const net = r.network;
  if (!net || !net.settles) return { problems: [], tx: null, pending: false };
  const room = pda.room(net.roomIndex, programId);
  const want = BigInt(net.chainRound ?? '-1');
  const vaults = [...r.seats]
    .filter((x) => x.slot !== null && x.wallet)
    .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
    .map((x) => pda.vault(new PublicKey(x.wallet!), programId).toBase58());
  const candidates = s.settleTx ? [s.settleTx] : (await conn.getSignaturesForAddress(room, { limit: 100 })).filter((x) => !x.err).map((x) => x.signature);
  for (const sig of candidates) {
    const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    if (!tx) continue;
    const ak = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses ?? undefined });
    const key = (i: number) => ak.get(i);
    for (const ix of tx.transaction.message.compiledInstructions) {
      if (!key(ix.programIdIndex)?.equals(programId)) continue;
      const data = Buffer.from(ix.data);
      if (data.length < 24 || !data.subarray(0, 8).equals(SETTLE)) continue;
      const round = data.readBigUInt64LE(8);
      if (round !== want || !key(ix.accountKeyIndexes[2])?.equals(room)) continue;
      const problems: string[] = [];
      if (tx.meta?.err) problems.push(`settle transaction ${short(sig)} failed`);
      const outcomes = [...data.subarray(16, 24)];
      if (!same(outcomes, r.outcome.slots)) problems.push(`onchain outcome [${outcomes.join(',')}] is not the signed [${r.outcome.slots.join(',')}]`);
      const seated = ix.accountKeyIndexes.slice(3).map((i) => key(i)?.toBase58());
      if (!same(seated, vaults)) problems.push('the settled vaults are not the seats the record names');
      return { problems, tx: sig, pending: false };
    }
  }
  const age = Date.now() - Date.parse(r.endedAt);
  if (age < 10 * 60_000) return { problems: [], tx: null, pending: true };
  return { problems: [`no settle transaction for room ${net.roomIndex} round ${net.chainRound} was found`], tx: null, pending: false };
}

/** Fetches the newest records from the site and checks each one. */
export async function checkRounds(conn: Connection, programId: PublicKey, gameServerKey: string, site: string, limit = 20, cluster?: string): Promise<Report> {
  const url = `${site.replace(/\/$/, '')}/api/rounds?limit=${limit}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const body = (await res.json()) as { signer: string | null; cluster: string | null; program: string | null; rounds: SignedRoundRecord[] };
  const checks: Check[] = [];
  if (body.signer !== gameServerKey) checks.push({ name: 'the site names the game server key as its signer', ok: false, detail: `${body.signer ?? 'none'} vs ${gameServerKey}` });
  for (const s of body.rounds) {
    const r = s.record;
    const name = `${r.room} round ${r.round}${r.network?.chainRound ? ` (chain round ${r.network.chainRound})` : ''}`;
    const problems = checkRecordOffline(s, gameServerKey);
    if (r.network && r.network.program !== programId.toBase58()) problems.push(`names program ${short(r.network.program)}`);
    if (cluster && r.network && r.network.cluster !== cluster) problems.push(`names ${r.network.cluster}, not ${cluster}`);
    let settled = '';
    try {
      const st = await checkSettlement(conn, programId, s);
      problems.push(...st.problems);
      settled = st.tx ? `, settled by ${short(st.tx)}` : st.pending ? ', settlement pending' : r.network?.settles ? '' : ', unstaked';
    } catch (err) {
      problems.push(`settlement not checked: ${(err as Error).message}`);
    }
    checks.push({ name, ok: problems.length === 0, detail: problems.length ? problems.join('; ') : `signed, dealt from its commit, outcome matches the captures${settled}` });
  }
  if (!body.rounds.length) checks.push({ name: 'rounds', ok: true, warn: true, detail: 'no rounds recorded yet' });
  return { ok: checks.every((c) => c.ok), checks };
}
