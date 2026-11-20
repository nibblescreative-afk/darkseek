// The read only HTTP API. Everything it serves is public chain data.
//
//   GET /health                     sync state
//   GET /stats                      rounds, stakes, fees by bucket, $DS burned and rebated,
//                                   with the program's own running totals beside them
//   GET /rounds?room=&limit=        recent rounds
//   GET /rounds/:room/:round        one round: seats, fee split, outcome, payouts, rebates
//   GET /solvency                   the SDK's solvency check, live (cached briefly)
//   GET /events?name=&limit=&before_slot=

import http from 'node:http';
import type { Connection, PublicKey } from '@solana/web3.js';
import { checkSolvency, explorerUrl, fetchConfig, maskSlots, type Cluster, type ConfigAccount, type SolvencyReport } from '@darkseek/sdk';
import type { Store } from './store.js';
import type { Follower } from './follower.js';

export interface ApiOptions {
  store: Store;
  follower?: Follower;
  conn: Connection;
  programId: PublicKey;
  cluster: Cluster;
  solvencyCacheMs: number;
}

const str = (v: unknown): unknown => {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(str);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, str(x)]));
  return v;
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createApi(o: ApiOptions): http.Server {
  let solvency: { at: number; value: SolvencyReport } | null = null;
  let config: { at: number; value: ConfigAccount } | null = null;
  const link = (sig: unknown) => (sig ? explorerUrl('tx', String(sig), o.cluster) : null);

  async function onchainConfig(): Promise<ConfigAccount | null> {
    if (config && Date.now() - config.at < 10_000) return config.value;
    try {
      config = { at: Date.now(), value: await fetchConfig(o.conn, o.programId) };
      return config.value;
    } catch {
      return null;
    }
  }

  function roundView(r: Record<string, unknown>) {
    const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : null);
    const owners = parse(r.owners) as string[] | null;
    const payouts = parse(r.payouts) as string[] | null;
    const refunds = parse(r.refunds) as string[] | null;
    const losers = r.losers === null || r.losers === undefined ? [] : maskSlots(Number(r.losers));
    // settled: the losing seats share the rebate; refunded after the start: every seat lost the fee
    const credited = (slot: number) => (r.status === 'settled' ? losers.includes(slot) : r.status === 'refunded' && refunds?.[slot] !== '0') ? String(r.rebate_usdc ?? 0) : '0';
    return {
      room: Number(r.room),
      round: String(r.round),
      tier: r.tier === null ? null : Number(r.tier) === 0 ? 'casual' : 'pro',
      status: r.status,
      startedAt: r.started_at === null ? null : Number(r.started_at),
      endedAt: r.ended_at === null ? null : Number(r.ended_at),
      fee:
        r.fee === null
          ? null
          : { total: String(r.fee), stakers: String(r.to_stakers), rebate: String(r.to_rebate), buyback: String(r.to_buyback), treasury: String(r.to_treasury) },
      gross: r.gross === null ? null : String(r.gross),
      pot: r.pot === null ? null : String(r.pot),
      seekersWon: r.seekers_won === null ? null : r.seekers_won === 1n || r.seekers_won === 1,
      outcomes: parse(r.outcomes),
      seats: owners?.map((owner, slot) => ({
        slot,
        role: slot < 2 ? 'seeker' : 'hider',
        owner,
        payout: payouts?.[slot] ?? null,
        refund: refunds?.[slot] ?? null,
        rebateUsdc: credited(slot),
      })),
      refunds,
      dust: r.dust === null ? null : String(r.dust),
      transactions: { started: link(r.started_sig), ended: link(r.ended_sig) },
    };
  }

  async function stats() {
    const s = o.store;
    const t = s.roundTotals();
    const onchain = await onchainConfig();
    const indexed = {
      rounds: { started: String(t.started ?? 0), settled: String(t.settled ?? 0), refunded: String(t.refunded ?? 0), live: String(t.live ?? 0) },
      staked: String(t.gross),
      fees: { total: String(t.fees), stakers: String(t.to_stakers), rebate: String(t.to_rebate), buyback: String(t.to_buyback), treasury: String(t.to_treasury) },
      byTier: s.roundsByTier().map((x) => ({ tier: Number(x.tier) === 0 ? 'casual' : 'pro', rounds: String(x.rounds), staked: String(x.gross), fees: String(x.fees) })),
      buyback: {
        fills: String(s.countOf('Buyback')),
        usdcFromBuyback: String(s.sumOf('Buyback', 'fromBuyback')),
        usdcFromRebate: String(s.sumOf('Buyback', 'fromRebate')),
        dsBurned: String(s.sumOf('Buyback', 'dsBurned')),
        dsToReserve: String(s.sumOf('Buyback', 'dsToReserve')),
      },
      rebates: { credited: String(s.rebatesCredited()), claimed: String(s.sumOf('RebateClaimed', 'usdc')), dsPaid: String(s.sumOf('RebateClaimed', 'ds')) },
      ds: { staked: String(s.sumOf('DsStaked', 'amount') - s.sumOf('DsUnstaked', 'amount')), rewardsClaimed: String(s.sumOf('RewardsClaimed', 'amount')) },
      vaults: { opened: String(s.countOf('VaultOpened')), deposited: String(s.sumOf('Deposited', 'amount')), withdrawn: String(s.sumOf('Withdrawn', 'amount')) },
      treasurySwept: String(s.sumOf('TreasurySwept', 'amount')),
    };
    return {
      programId: o.programId.toBase58(),
      cluster: o.cluster,
      units: 'base units: USDC and $DS both have six decimals',
      indexed,
      onchain: onchain
        ? str({
            totals: onchain.totals,
            pools: { treasury: onchain.treasury, stakers: onchain.stakerPool, rebate: onchain.rebatePool, buyback: onchain.buybackPool },
            buyback: { target: onchain.buybackTarget, initialTarget: onchain.buybackTargetInitial, roundsDone: onchain.buybacksDone, roundLeft: onchain.buybackRoundLeft },
            rebates: { reserve: onchain.dsReserve, reserveCost: onchain.reserveCost, credits: onchain.rebateCredits },
            dsStaked: onchain.dsStaked,
          })
        : null,
    };
  }

  async function route(url: URL): Promise<unknown> {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'health' && parts.length === 1) {
      const cursor = o.store.cursor();
      return { ok: !o.follower?.lastError, lastSlot: cursor?.slot ?? null, lastSyncAt: o.follower?.lastSyncAt || null, error: o.follower?.lastError ?? null, events: String(o.store.eventCount()) };
    }
    if (parts[0] === 'stats' && parts.length === 1) return stats();
    if (parts[0] === 'solvency' && parts.length === 1) {
      if (!solvency || Date.now() - solvency.at > o.solvencyCacheMs) solvency = { at: Date.now(), value: await checkSolvency(o.conn, o.programId) };
      return { checkedAt: Math.floor(solvency.at / 1000), ...(str(solvency.value) as object) };
    }
    if (parts[0] === 'rounds' && parts.length === 1) {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 20) || 20, 200);
      const room = url.searchParams.get('room');
      return o.store.recentRounds(limit, room === null ? undefined : Number(room)).map(roundView);
    }
    if (parts[0] === 'rounds' && parts.length === 3) {
      const room = Number(parts[1]);
      if (!Number.isInteger(room) || room < 1 || room > 6 || !/^\d{1,20}$/.test(parts[2])) throw new HttpError(400, 'expected /rounds/<room 1 to 6>/<round>');
      const round = BigInt(parts[2]);
      const r = o.store.round(room, round);
      const stakes = o.store.stakesOf(room, round);
      if (!r && !stakes.length) throw new HttpError(404, 'no such round');
      return { ...(r ? roundView(r) : { room, round: String(round), status: 'open' }), stakeEvents: str(stakes) };
    }
    if (parts[0] === 'events' && parts.length === 1) {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 500);
      const before = url.searchParams.get('before_slot');
      return o.store.events(url.searchParams.get('name'), limit, before === null ? null : Number(before)).map((e) => ({ ...(str(e) as object), data: JSON.parse(String(e.data)) }));
    }
    throw new HttpError(404, 'not found');
  }

  return http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { error: 'read only' });
    route(new URL(req.url ?? '/', 'http://localhost')).then(
      (body) => send(200, body),
      (err) => send(err instanceof HttpError ? err.status : 500, { error: err instanceof HttpError ? err.message : 'internal error' }),
    );
  });
}
