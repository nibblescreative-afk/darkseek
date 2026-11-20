// Decoding the program's events from transaction logs.
//
// Anchor's `emit!` writes each event as a `Program data: <base64>` log line
// while the program runs. Only lines logged while the vault program itself is
// the innermost running program are taken, so another program cannot forge one
// by logging the same bytes.

import type { PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { Reader, discriminator } from './codec.js';
import { PROGRAM_ID } from './constants.js';
import { EVENT_LAYOUTS, type EventName } from './layouts.js';

export const EVENT_DISCRIMINATORS = Object.fromEntries(
  (Object.keys(EVENT_LAYOUTS) as EventName[]).map((n) => [n, discriminator('event', n)]),
) as Record<EventName, Buffer>;

const BY_DISCRIMINATOR = new Map<string, EventName>(Object.entries(EVENT_DISCRIMINATORS).map(([n, d]) => [d.toString('hex'), n as EventName]));

export interface DecodedEvent {
  name: EventName;
  data: Record<string, unknown>;
}

/** Decodes one event body (discriminator first); null if it is not one of ours. */
export function decodeEvent(bytes: Uint8Array): DecodedEvent | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length < 8) return null;
  const name = BY_DISCRIMINATOR.get(b.subarray(0, 8).toString('hex'));
  if (!name) return null;
  const data = new Reader(b, 8).read({ struct: EVENT_LAYOUTS[name] }) as Record<string, unknown>;
  return { name, data };
}

/** Every event the program logged in one transaction, in order. */
export function parseEvents(logs: readonly string[], programId: PublicKey = PROGRAM_ID): DecodedEvent[] {
  const id = programId.toBase58();
  const stack: string[] = [];
  const out: DecodedEvent[] = [];
  for (const line of logs) {
    const invoke = /^Program (\w+) invoke \[\d+\]$/.exec(line);
    if (invoke) {
      stack.push(invoke[1]);
      continue;
    }
    if (/^Program \w+ (success|failed)/.test(line)) {
      stack.pop();
      continue;
    }
    if (line.startsWith('Program data: ') && stack[stack.length - 1] === id) {
      const ev = decodeEvent(Buffer.from(line.slice('Program data: '.length), 'base64'));
      if (ev) out.push(ev);
    }
  }
  return out;
}

/** Turns bigint and PublicKey fields into strings, for JSON. */
export function eventToJson(data: unknown): unknown {
  if (typeof data === 'bigint') return data.toString();
  if (data && typeof data === 'object') {
    if (typeof (data as { toBase58?: unknown }).toBase58 === 'function') return (data as PublicKey).toBase58();
    if (Array.isArray(data)) return data.map(eventToJson);
    return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, eventToJson(v)]));
  }
  return data;
}
