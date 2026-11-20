// Follows the program through RPC: pages its transaction signatures from the
// last one stored up to the newest, fetches each transaction and stores the
// events the program logged. Failed transactions changed nothing, so their logs
// are skipped. Restarting resumes from the cursor; replaying a transaction is
// harmless (events are keyed by signature and position).

import { Connection, type ConfirmedSignatureInfo, type Finality, type PublicKey } from '@solana/web3.js';
import { parseEvents } from '@darkseek/sdk';
import type { Store } from './store.js';

export interface FollowerOptions {
  conn: Connection;
  programId: PublicKey;
  store: Store;
  commitment: Finality;
  log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
}

export class Follower {
  private stopped = false;
  lastSyncAt = 0;
  lastError: string | null = null;

  constructor(private readonly o: FollowerOptions) {}

  private log(level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) {
    this.o.log?.(level, msg, extra);
  }

  /** Signatures after the cursor, oldest first. */
  private async pending(): Promise<ConfirmedSignatureInfo[]> {
    const until = this.o.store.cursor()?.signature;
    const out: ConfirmedSignatureInfo[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.o.conn.getSignaturesForAddress(this.o.programId, { before, until, limit: 1_000 }, this.o.commitment);
      out.push(...page);
      if (page.length < 1_000) break;
      before = page[page.length - 1].signature;
    }
    return out.reverse();
  }

  /** Stores everything new; returns how many transactions were processed. */
  async syncOnce(): Promise<number> {
    const sigs = await this.pending();
    for (const s of sigs) {
      if (s.err) {
        this.o.store.apply({ signature: s.signature, slot: s.slot, blockTime: s.blockTime ?? null, events: [] });
        continue;
      }
      const tx = await this.o.conn.getTransaction(s.signature, { commitment: this.o.commitment, maxSupportedTransactionVersion: 0 });
      if (!tx) throw new Error(`transaction ${s.signature} not found`);
      const events = tx.meta?.err ? [] : parseEvents(tx.meta?.logMessages ?? [], this.o.programId);
      if ((tx.meta?.logMessages ?? []).some((l) => l.startsWith('Log truncated'))) {
        this.log('warn', 'logs truncated: events of this transaction may be missing', { signature: s.signature });
      }
      this.o.store.apply({ signature: s.signature, slot: tx.slot, blockTime: tx.blockTime ?? null, events });
    }
    this.lastSyncAt = Date.now();
    if (sigs.length) this.log('info', 'synced', { transactions: sigs.length, slot: this.o.store.cursor()?.slot });
    return sigs.length;
  }

  /** Polls until `stop()`, backing off on RPC errors. */
  async run(pollMs: number): Promise<void> {
    let wait = pollMs;
    while (!this.stopped) {
      try {
        await this.syncOnce();
        this.lastError = null;
        wait = pollMs;
      } catch (err) {
        this.lastError = String((err as Error).message ?? err);
        this.log('error', 'sync failed', { error: this.lastError });
        wait = Math.min(wait * 2, 60_000);
      }
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  stop(): void {
    this.stopped = true;
  }
}
