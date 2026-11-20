// SQLite storage (node:sqlite, no native module). Every event is kept as it
// was decoded; the rounds table is a view of them kept up to date as they
// arrive. Writing a transaction's events and moving the cursor happen in one
// SQLite transaction, so a crash never half applies a transaction.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { eventToJson, type DecodedEvent } from '@darkseek/sdk';

export interface StoredTx {
  signature: string;
  slot: number;
  blockTime: number | null;
  events: DecodedEvent[];
}

type Row = Record<string, unknown>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  signature  TEXT    NOT NULL,
  idx        INTEGER NOT NULL,
  slot       INTEGER NOT NULL,
  block_time INTEGER,
  name       TEXT    NOT NULL,
  data       TEXT    NOT NULL,
  PRIMARY KEY (signature, idx)
);
CREATE INDEX IF NOT EXISTS events_by_name ON events (name, slot);

CREATE TABLE IF NOT EXISTS rounds (
  room        INTEGER NOT NULL,
  round       INTEGER NOT NULL,
  tier        INTEGER,
  status      TEXT    NOT NULL CHECK (status IN ('live', 'settled', 'refunded')),
  started_sig TEXT,
  started_at  INTEGER,
  ended_sig   TEXT,
  ended_at    INTEGER,
  owners      TEXT,
  gross       INTEGER,
  fee         INTEGER,
  to_stakers  INTEGER,
  to_rebate   INTEGER,
  to_buyback  INTEGER,
  to_treasury INTEGER,
  pot         INTEGER,
  seekers_won INTEGER,
  outcomes    TEXT,
  payouts     TEXT,
  losers      INTEGER,
  rebate_usdc INTEGER,
  dust        INTEGER,
  refunds     TEXT,
  PRIMARY KEY (room, round)
);

CREATE TABLE IF NOT EXISTS cursor (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  signature TEXT    NOT NULL,
  slot      INTEGER NOT NULL
);
`;

const json = (v: unknown) => JSON.stringify(eventToJson(v));
const big = (v: unknown) => BigInt(v as bigint);

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  cursor(): { signature: string; slot: number } | null {
    const row = this.db.prepare('SELECT signature, slot FROM cursor WHERE id = 1').get() as Row | undefined;
    return row ? { signature: String(row.signature), slot: Number(row.slot) } : null;
  }

  /** Stores one transaction's events (idempotent) and moves the cursor past it. */
  apply(tx: StoredTx): void {
    this.db.exec('BEGIN');
    try {
      const insert = this.db.prepare('INSERT OR IGNORE INTO events (signature, idx, slot, block_time, name, data) VALUES (?, ?, ?, ?, ?, ?)');
      tx.events.forEach((ev, idx) => {
        insert.run(tx.signature, idx, tx.slot, tx.blockTime, ev.name, json(ev.data));
        this.project(ev, tx);
      });
      this.db.prepare('INSERT INTO cursor (id, signature, slot) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET signature = excluded.signature, slot = excluded.slot').run(tx.signature, tx.slot);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Keeps the rounds table in step with the events. */
  private project(ev: DecodedEvent, tx: StoredTx): void {
    const d = ev.data;
    if (ev.name === 'RoundStarted') {
      this.db
        .prepare(
          `INSERT INTO rounds (room, round, tier, status, started_sig, started_at, owners, gross, fee, to_stakers, to_rebate, to_buyback, to_treasury, pot)
           VALUES (?, ?, ?, 'live', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (room, round) DO NOTHING`,
        )
        .run(d.room as number, big(d.round), d.tier as number, tx.signature, tx.blockTime, json(d.owners), big(d.gross), big(d.fee), big(d.toStakers), big(d.toRebate), big(d.toBuyback), big(d.toTreasury), big(d.pot));
    } else if (ev.name === 'RoundSettled') {
      this.db
        .prepare(
          `UPDATE rounds SET status = 'settled', ended_sig = ?, ended_at = ?, seekers_won = ?, outcomes = ?, payouts = ?, losers = ?, rebate_usdc = ?, dust = ?
           WHERE room = ? AND round = ?`,
        )
        .run(tx.signature, tx.blockTime, d.seekersWon ? 1 : 0, json(d.outcomes), json(d.payouts), d.losers as number, big(d.rebateUsdc), big(d.dust), d.room as number, big(d.round));
    } else if (ev.name === 'RoundRefunded') {
      this.db
        .prepare(
          `INSERT INTO rounds (room, round, status, ended_sig, ended_at, refunds, rebate_usdc) VALUES (?, ?, 'refunded', ?, ?, ?, ?)
           ON CONFLICT (room, round) DO UPDATE SET status = 'refunded', ended_sig = excluded.ended_sig, ended_at = excluded.ended_at, refunds = excluded.refunds, rebate_usdc = excluded.rebate_usdc`,
        )
        .run(d.room as number, big(d.round), tx.signature, tx.blockTime, json(d.refunds), big(d.rebateUsdc));
    }
  }

  // ---------------------------------------------------------------- reads

  private all(sql: string, ...params: (string | number | bigint | null)[]): Row[] {
    const s = this.db.prepare(sql);
    s.setReadBigInts(true);
    return s.all(...params) as Row[];
  }
  private one(sql: string, ...params: (string | number | bigint | null)[]): Row {
    return this.all(sql, ...params)[0] ?? {};
  }

  /** Sum of a numeric field over every event of one kind. */
  sumOf(name: string, field: string): bigint {
    const r = this.one(`SELECT COALESCE(SUM(CAST(json_extract(data, '$.${field}') AS INTEGER)), 0) AS v FROM events WHERE name = ?`, name);
    return BigInt(r.v as bigint);
  }

  countOf(name: string): bigint {
    return BigInt(this.one('SELECT COUNT(*) AS v FROM events WHERE name = ?', name).v as bigint);
  }

  roundTotals(): Row {
    return this.one(`SELECT
        COUNT(started_sig) AS started,
        SUM(status = 'settled') AS settled,
        SUM(status = 'refunded') AS refunded,
        SUM(status = 'live') AS live,
        COALESCE(SUM(gross), 0) AS gross,
        COALESCE(SUM(fee), 0) AS fees,
        COALESCE(SUM(to_stakers), 0) AS to_stakers,
        COALESCE(SUM(to_rebate), 0) AS to_rebate,
        COALESCE(SUM(to_buyback), 0) AS to_buyback,
        COALESCE(SUM(to_treasury), 0) AS to_treasury,
        COALESCE(SUM(dust), 0) AS dust
      FROM rounds`);
  }

  roundsByTier(): Row[] {
    return this.all('SELECT tier, COUNT(*) AS rounds, COALESCE(SUM(gross), 0) AS gross, COALESCE(SUM(fee), 0) AS fees FROM rounds WHERE started_sig IS NOT NULL GROUP BY tier ORDER BY tier');
  }

  /** USDC of rebates credited: each settled round's per seat credit times its losing seats, and every seat of a round refunded after its start. */
  rebatesCredited(): bigint {
    let total = 0n;
    for (const r of this.all("SELECT status, rebate_usdc, losers, refunds FROM rounds WHERE rebate_usdc IS NOT NULL")) {
      let n = 0n;
      if (r.status === 'settled') for (let m = Number(r.losers); m; m &= m - 1) n++;
      else n = BigInt((JSON.parse(String(r.refunds)) as string[]).filter((x) => x !== '0').length);
      total += BigInt(r.rebate_usdc as bigint) * n;
    }
    return total;
  }

  round(room: number, round: bigint): Row | null {
    return this.all('SELECT * FROM rounds WHERE room = ? AND round = ?', room, round)[0] ?? null;
  }

  recentRounds(limit: number, room?: number): Row[] {
    return room === undefined
      ? this.all('SELECT * FROM rounds ORDER BY COALESCE(ended_at, started_at) DESC, room, round DESC LIMIT ?', limit)
      : this.all('SELECT * FROM rounds WHERE room = ? ORDER BY round DESC LIMIT ?', room, limit);
  }

  /** Stakes locked for a round, by slot (StakeLocked events), for rounds that never started. */
  stakesOf(room: number, round: bigint): Row[] {
    return this.all(
      `SELECT name, signature, json_extract(data, '$.slot') AS slot, json_extract(data, '$.owner') AS owner, json_extract(data, '$.stake') AS stake
       FROM events WHERE name IN ('StakeLocked', 'StakeUnlocked') AND json_extract(data, '$.room') = ? AND json_extract(data, '$.round') = ?
       ORDER BY slot, rowid`,
      room,
      round.toString(),
    );
  }

  events(name: string | null, limit: number, beforeSlot: number | null): Row[] {
    const where = [name ? 'name = ?' : null, beforeSlot !== null ? 'slot < ?' : null].filter(Boolean).join(' AND ');
    const params = [name, beforeSlot].filter((p) => p !== null) as (string | number)[];
    return this.all(`SELECT signature, idx, slot, block_time, name, data FROM events ${where ? `WHERE ${where}` : ''} ORDER BY slot DESC, signature, idx LIMIT ?`, ...params, limit);
  }

  eventCount(): bigint {
    return BigInt(this.one('SELECT COUNT(*) AS v FROM events').v as bigint);
  }
}
