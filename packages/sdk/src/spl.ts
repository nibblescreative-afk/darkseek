// SPL Token and Token 2022 account decoders (with extensions) and the few
// token instructions the scripts and tests need, written from the programs'
// published layouts so the SDK needs no token library.

import { PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { sha256 } from '@noble/hashes/sha2';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './constants.js';
import { ata } from './pda.js';

export const MINT_SIZE = 82;
export const TOKEN_ACCOUNT_SIZE = 165;

/** Token 2022 extension types (spl-token-2022 ExtensionType). */
export const EXT = {
  TransferFeeConfig: 1,
  TransferFeeAmount: 2,
  MintCloseAuthority: 3,
  ConfidentialTransferMint: 4,
  ConfidentialTransferAccount: 5,
  DefaultAccountState: 6,
  ImmutableOwner: 7,
  MemoTransfer: 8,
  NonTransferable: 9,
  InterestBearingConfig: 10,
  CpiGuard: 11,
  PermanentDelegate: 12,
  NonTransferableAccount: 13,
  TransferHook: 14,
  TransferHookAccount: 15,
  ConfidentialTransferFeeConfig: 16,
  ConfidentialTransferFeeAmount: 17,
  MetadataPointer: 18,
  TokenMetadata: 19,
  GroupPointer: 20,
  TokenGroup: 21,
  GroupMemberPointer: 22,
  TokenGroupMember: 23,
  ConfidentialMintBurn: 24,
  ScaledUiAmount: 25,
  Pausable: 26,
  PausableAccount: 27,
} as const;

export const EXT_NAME: Record<number, string> = Object.fromEntries(Object.entries(EXT).map(([k, v]) => [v, k]));

export interface MintInfo {
  programId: PublicKey;
  mintAuthority: PublicKey | null;
  supply: bigint;
  decimals: number;
  isInitialized: boolean;
  freezeAuthority: PublicKey | null;
  /** Token 2022 extensions: type → raw value */
  extensions: Map<number, Buffer>;
}

export interface TokenAccountInfo {
  mint: PublicKey;
  owner: PublicKey;
  amount: bigint;
  delegate: PublicKey | null;
  state: number;
  closeAuthority: PublicKey | null;
}

const coption = (b: Buffer, at: number): PublicKey | null => (b.readUInt32LE(at) === 1 ? new PublicKey(b.subarray(at + 4, at + 36)) : null);

function extensionsOf(b: Buffer, accountType: 1 | 2): Map<number, Buffer> {
  const out = new Map<number, Buffer>();
  if (b.length <= TOKEN_ACCOUNT_SIZE || b[TOKEN_ACCOUNT_SIZE] !== accountType) return out;
  let at = TOKEN_ACCOUNT_SIZE + 1;
  while (at + 4 <= b.length) {
    const type = b.readUInt16LE(at);
    const len = b.readUInt16LE(at + 2);
    if (type === 0) break;
    out.set(type, b.subarray(at + 4, at + 4 + len));
    at += 4 + len;
  }
  return out;
}

/** Decodes a mint of either token program. `owner` is the account's owner program. */
export function decodeMint(data: Uint8Array, owner: PublicKey): MintInfo {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (!owner.equals(TOKEN_PROGRAM_ID) && !owner.equals(TOKEN_2022_PROGRAM_ID)) throw new Error('not owned by a token program');
  if (b.length < MINT_SIZE) throw new Error('not a mint');
  return {
    programId: owner,
    mintAuthority: coption(b, 0),
    supply: b.readBigUInt64LE(36),
    decimals: b[44],
    isInitialized: b[45] === 1,
    freezeAuthority: coption(b, 46),
    extensions: owner.equals(TOKEN_2022_PROGRAM_ID) ? extensionsOf(b, 1) : new Map(),
  };
}

export function decodeTokenAccount(data: Uint8Array): TokenAccountInfo {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (b.length < TOKEN_ACCOUNT_SIZE) throw new Error('not a token account');
  return {
    mint: new PublicKey(b.subarray(0, 32)),
    owner: new PublicKey(b.subarray(32, 64)),
    amount: b.readBigUInt64LE(64),
    delegate: coption(b, 72),
    state: b[108],
    closeAuthority: coption(b, 129),
  };
}

const optionalKey = (b: Buffer, at: number): PublicKey | null => {
  const k = new PublicKey(b.subarray(at, at + 32));
  return k.equals(PublicKey.default) ? null : k;
};

export interface MetadataPointer {
  authority: PublicKey | null;
  metadataAddress: PublicKey | null;
}

export const decodeMetadataPointer = (v: Buffer): MetadataPointer => ({ authority: optionalKey(v, 0), metadataAddress: optionalKey(v, 32) });

export interface TokenMetadata {
  updateAuthority: PublicKey | null;
  mint: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  additional: [string, string][];
}

export function decodeTokenMetadata(v: Buffer): TokenMetadata {
  let at = 64;
  const str = () => {
    const len = v.readUInt32LE(at);
    const s = v.subarray(at + 4, at + 4 + len).toString('utf8');
    at += 4 + len;
    return s;
  };
  const updateAuthority = optionalKey(v, 0);
  const mint = new PublicKey(v.subarray(32, 64));
  const name = str();
  const symbol = str();
  const uri = str();
  const additional: [string, string][] = [];
  const n = at + 4 <= v.length ? v.readUInt32LE(at) : 0;
  at += 4;
  for (let i = 0; i < n; i++) additional.push([str(), str()]);
  return { updateAuthority, mint, name, symbol, uri, additional };
}

// ---------------------------------------------------------------------- instructions

const w = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });
const u64 = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};
const str = (s: string) => {
  const body = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length);
  return Buffer.concat([len, body]);
};

export const AUTHORITY_TYPE = { MintTokens: 0, FreezeAccount: 1, AccountOwner: 2, CloseAccount: 3 } as const;

export const splIxs = {
  /** InitializeMint2 with no freeze authority. The account must exist, owned by the token program. */
  initializeMint2: (mint: PublicKey, decimals: number, mintAuthority: PublicKey, programId = TOKEN_PROGRAM_ID) =>
    new TransactionInstruction({ programId, keys: [w(mint)], data: Buffer.concat([Buffer.from([20, decimals]), mintAuthority.toBuffer(), Buffer.from([0])]) }),
  mintTo: (mint: PublicKey, to: PublicKey, authority: PublicKey, amount: bigint, programId = TOKEN_PROGRAM_ID) =>
    new TransactionInstruction({ programId, keys: [w(mint), w(to), r(authority, true)], data: Buffer.concat([Buffer.from([7]), u64(amount)]) }),
  /** SetAuthority; `next` null removes the authority for good. */
  setAuthority: (account: PublicKey, current: PublicKey, type: number, next: PublicKey | null, programId = TOKEN_PROGRAM_ID) =>
    new TransactionInstruction({
      programId,
      keys: [w(account), r(current, true)],
      data: Buffer.concat([Buffer.from([6, type]), next ? Buffer.concat([Buffer.from([1]), next.toBuffer()]) : Buffer.from([0])]),
    }),
  transferChecked: (from: PublicKey, mint: PublicKey, to: PublicKey, owner: PublicKey, amount: bigint, decimals: number, programId = TOKEN_PROGRAM_ID) =>
    new TransactionInstruction({ programId, keys: [w(from), r(mint), w(to), r(owner, true)], data: Buffer.concat([Buffer.from([12]), u64(amount), Buffer.from([decimals])]) }),
  createAtaIdempotent: (payer: PublicKey, owner: PublicKey, mint: PublicKey, programId = TOKEN_PROGRAM_ID) =>
    new TransactionInstruction({
      programId: ASSOCIATED_TOKEN_PROGRAM_ID,
      keys: [w(payer, true), w(ata(owner, mint, programId)), r(owner), r(mint), r(SystemProgram.programId), r(programId)],
      data: Buffer.from([1]),
    }),
  /** Token 2022: the mint says where its metadata lives. */
  initializeMetadataPointer: (mint: PublicKey, authority: PublicKey | null, metadataAddress: PublicKey) =>
    new TransactionInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      keys: [w(mint)],
      data: Buffer.concat([Buffer.from([39, 0]), (authority ?? PublicKey.default).toBuffer(), metadataAddress.toBuffer()]),
    }),
  /** Token 2022: a delegate that can move or burn anyone's tokens of this mint (checks must refuse it). */
  initializePermanentDelegate: (mint: PublicKey, delegate: PublicKey) =>
    new TransactionInstruction({ programId: TOKEN_2022_PROGRAM_ID, keys: [w(mint)], data: Buffer.concat([Buffer.from([35]), delegate.toBuffer()]) }),
  /** Token 2022: tokens of this mint can never be transferred (checks must refuse it). */
  initializeNonTransferableMint: (mint: PublicKey) => new TransactionInstruction({ programId: TOKEN_2022_PROGRAM_ID, keys: [w(mint)], data: Buffer.from([32]) }),
  /** Token 2022: name, symbol and uri stored in the mint itself. */
  initializeTokenMetadata: (mint: PublicKey, updateAuthority: PublicKey, mintAuthority: PublicKey, m: { name: string; symbol: string; uri: string }) =>
    new TransactionInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      keys: [w(mint), r(updateAuthority), r(mint), r(mintAuthority, true)],
      data: Buffer.concat([Buffer.from(sha256(new TextEncoder().encode('spl_token_metadata_interface:initialize_account'))).subarray(0, 8), str(m.name), str(m.symbol), str(m.uri)]),
    }),
};

/** Size of a Token 2022 mint with only the MetadataPointer extension. */
export const MINT_WITH_POINTER_SIZE = TOKEN_ACCOUNT_SIZE + 1 + 4 + 64;
/** Size of a Token 2022 mint with only the PermanentDelegate extension. */
export const MINT_WITH_DELEGATE_SIZE = TOKEN_ACCOUNT_SIZE + 1 + 4 + 32;
/** Size of a Token 2022 mint with only the NonTransferable extension. */
export const MINT_NON_TRANSFERABLE_SIZE = TOKEN_ACCOUNT_SIZE + 1 + 4;

/** Bytes the TokenMetadata entry adds to a mint (type and length included). */
export const tokenMetadataSize = (m: { name: string; symbol: string; uri: string }) =>
  4 + 32 + 32 + 4 + Buffer.byteLength(m.name) + 4 + Buffer.byteLength(m.symbol) + 4 + Buffer.byteLength(m.uri) + 4;
