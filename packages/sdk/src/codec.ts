// A small Borsh codec driven by field lists, plus Anchor discriminators.
// Accounts, events and instruction arguments are all described with it, so the
// layouts live in one place (layouts.ts) and are checked against the IDL.

import { sha256 } from '@noble/hashes/sha2';
import { PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';

export type Ty =
  | 'u8'
  | 'u16'
  | 'u32'
  | 'u64'
  | 'i64'
  | 'u128'
  | 'bool'
  | 'pubkey'
  | 'string'
  | { array: readonly [Ty, number] }
  | { struct: Fields };

export type Fields = readonly (readonly [string, Ty])[];

/** First 8 bytes of sha256("<namespace>:<name>"), as Anchor computes them. */
export function discriminator(namespace: 'global' | 'account' | 'event', name: string): Buffer {
  return Buffer.from(sha256(new TextEncoder().encode(`${namespace}:${name}`))).subarray(0, 8);
}

export class Reader {
  constructor(
    private readonly b: Buffer,
    public offset = 0,
  ) {}

  read(ty: Ty): unknown {
    const b = this.b;
    if (typeof ty === 'string') {
      switch (ty) {
        case 'u8':
          return b.readUInt8(this.offset++);
        case 'bool':
          return b.readUInt8(this.offset++) !== 0;
        case 'u16': {
          const v = b.readUInt16LE(this.offset);
          this.offset += 2;
          return v;
        }
        case 'u32': {
          const v = b.readUInt32LE(this.offset);
          this.offset += 4;
          return v;
        }
        case 'u64': {
          const v = b.readBigUInt64LE(this.offset);
          this.offset += 8;
          return v;
        }
        case 'i64': {
          const v = b.readBigInt64LE(this.offset);
          this.offset += 8;
          return v;
        }
        case 'u128': {
          const lo = b.readBigUInt64LE(this.offset);
          const hi = b.readBigUInt64LE(this.offset + 8);
          this.offset += 16;
          return (hi << 64n) | lo;
        }
        case 'pubkey': {
          const k = new PublicKey(b.subarray(this.offset, this.offset + 32));
          this.offset += 32;
          return k;
        }
        case 'string': {
          const len = b.readUInt32LE(this.offset);
          const s = b.subarray(this.offset + 4, this.offset + 4 + len).toString('utf8');
          this.offset += 4 + len;
          return s;
        }
      }
    }
    if ('array' in ty) {
      const [inner, n] = ty.array;
      return Array.from({ length: n }, () => this.read(inner));
    }
    const out: Record<string, unknown> = {};
    for (const [name, t] of ty.struct) out[name] = this.read(t);
    return out;
  }
}

export function encode(ty: Ty, value: unknown): Buffer {
  if (typeof ty === 'string') {
    switch (ty) {
      case 'u8':
        return Buffer.from([Number(value) & 0xff]);
      case 'bool':
        return Buffer.from([value ? 1 : 0]);
      case 'u16': {
        const b = Buffer.alloc(2);
        b.writeUInt16LE(Number(value));
        return b;
      }
      case 'u32': {
        const b = Buffer.alloc(4);
        b.writeUInt32LE(Number(value));
        return b;
      }
      case 'u64': {
        const b = Buffer.alloc(8);
        b.writeBigUInt64LE(BigInt(value as bigint | number));
        return b;
      }
      case 'i64': {
        const b = Buffer.alloc(8);
        b.writeBigInt64LE(BigInt(value as bigint | number));
        return b;
      }
      case 'u128': {
        const v = BigInt(value as bigint | number);
        const b = Buffer.alloc(16);
        b.writeBigUInt64LE(v & 0xffff_ffff_ffff_ffffn);
        b.writeBigUInt64LE(v >> 64n, 8);
        return b;
      }
      case 'pubkey':
        return (value as PublicKey).toBuffer();
      case 'string': {
        const s = Buffer.from(String(value), 'utf8');
        const len = Buffer.alloc(4);
        len.writeUInt32LE(s.length);
        return Buffer.concat([len, s]);
      }
    }
  }
  if ('array' in ty) {
    const [inner, n] = ty.array;
    const items = value as unknown[];
    if (items.length !== n) throw new Error(`expected ${n} items, got ${items.length}`);
    return Buffer.concat(items.map((v) => encode(inner, v)));
  }
  const obj = value as Record<string, unknown>;
  return Buffer.concat(ty.struct.map(([name, t]) => encode(t, obj[name])));
}

/** Byte size of a fixed size type (strings have none). */
export function sizeOf(ty: Ty): number {
  if (typeof ty === 'string') {
    const sizes: Record<string, number> = { u8: 1, bool: 1, u16: 2, u32: 4, u64: 8, i64: 8, u128: 16, pubkey: 32 };
    if (!(ty in sizes)) throw new Error(`${ty} has no fixed size`);
    return sizes[ty];
  }
  if ('array' in ty) return sizeOf(ty.array[0]) * ty.array[1];
  return ty.struct.reduce((s, [, t]) => s + sizeOf(t), 0);
}

/** Decodes an Anchor account or event body after checking its discriminator. */
export function decodeWithDiscriminator<T>(data: Uint8Array, disc: Buffer, fields: Fields, what: string): T {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (b.length < 8 || !b.subarray(0, 8).equals(disc)) throw new Error(`not a ${what}`);
  return new Reader(b, 8).read({ struct: fields }) as T;
}
