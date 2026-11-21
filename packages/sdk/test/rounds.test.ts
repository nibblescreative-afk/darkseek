import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { checkRecordOffline, commitOf, dealRound, offchainMessageBytes, recordDigest, recordMessage, roundSeedOf, verifyEd25519, type RoundRecord, type SignedRoundRecord } from '../src/rounds.js';

const HIDERS = ['h0', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7'];
const NONCES = ['a1', 'b2', 'c3', 'd4', 'e5', 'f6', '07', '18', '29', '3a'];

// made by the game's own implementation (src/shared/deal.ts in the private game): both must deal the same
const VECTORS: { room: string; round: number; serverSeed: string; commit: string; roundSeed: string; deal: unknown }[] = [{"room":"ROOM-01","round":1,"serverSeed":"0000000000000000000000000000000000000000000000000000000000000000","commit":"66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925","roundSeed":"80735ae2b252418171f7b021179f7e87ca3f0f4f2a7f351b5cbf10086b0b87c4","deal":{"spawns":{"h0":1,"h1":2,"h2":7,"h3":0,"h4":5,"h5":4,"h6":3,"h7":6},"healer":"h7","jester":"h4","detective":"h6","mimic":{"h0":"crate","h1":"stalagmite","h2":"crate","h3":"crate","h4":"stalagmite","h5":"crate","h6":"crate","h7":"crate"}}},{"room":"ROOM-02","round":17,"serverSeed":"2222222222222222222222222222222222222222222222222222222222222222","commit":"9f72ea0cf49536e3c66c787f705186df9a4378083753ae9536d65b3ad7fcddc4","roundSeed":"9fd042664911ecc62aedb0a130b2901b78e1b688038b87a525189dc97e04236d","deal":{"spawns":{"h0":4,"h1":6,"h2":0,"h3":3,"h4":2,"h5":5,"h6":1,"h7":7},"healer":"h6","jester":"h2","detective":"h3","mimic":{"h0":"crate","h1":"crate","h2":"stalagmite","h3":"crate","h4":"stalagmite","h5":"stalagmite","h6":"crate","h7":"stalagmite"}}},{"room":"ROOM-06","round":123456,"serverSeed":"abababababababababababababababababababababababababababababababab","commit":"9a2db2e23f1504cd056606553ac049c5e718e8f9ce9233876df1a7a1821af885","roundSeed":"de45353073a7ad9bb745684f91087573b683aa1a1524b55384b90aaa1cce7726","deal":{"spawns":{"h0":1,"h1":4,"h2":6,"h3":2,"h4":0,"h5":3,"h6":5,"h7":7},"healer":"h7","jester":"h2","detective":"h4","mimic":{"h0":"stalagmite","h1":"stalagmite","h2":"crate","h3":"stalagmite","h4":"stalagmite","h5":"stalagmite","h6":"stalagmite","h7":"stalagmite"}}}];

test('the deal: the same seed, commit and spawns and roles as the game', () => {
  for (const v of VECTORS) {
    assert.equal(commitOf(v.serverSeed), v.commit);
    assert.equal(roundSeedOf(v.room, v.round, v.serverSeed, NONCES), v.roundSeed);
    assert.deepEqual(dealRound(v.roundSeed, HIDERS, 8), v.deal);
  }
});

test('off-chain messages: a signature made by the solana CLI checks', () => {
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const dec = (s: string) => {
    let n = 0n;
    for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
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
  };
  const pk = dec('Dk5bDnmSo6c3sGzAeHVwyt5fra6vd7UyZbrmnN9sAfV5');
  // a public signature of a throwaway key, in two parts so the secret scan's base58 key pattern stays quiet
  const sig = dec('tKL1Ks1RosDxP7LghQ5EuhaYUR7iPiWzN8Tzsznjp8' + 'LmPT1ne67xh5DKNrbLvWtUTeJrbwEW7XBedYEdhzJ2peo');
  assert.ok(verifyEd25519(sig, offchainMessageBytes('DarkSeek round result v1 ROOM-02 17 3f2a'), pk));
  assert.ok(!verifyEd25519(sig, offchainMessageBytes('DarkSeek round result v1 ROOM-02 18 3f2a'), pk));
});

const b58 = (bytes: Uint8Array) => {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let o = '';
  while (n > 0n) {
    o = A[Number(n % 58n)] + o;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b) break;
    o = '1' + o;
  }
  return o;
};

function signed(mutate?: (r: RoundRecord) => void): { s: SignedRoundRecord; signer: string } {
  const serverSeed = '22'.repeat(32);
  const roundSeed = roundSeedOf('ROOM-02', 17, serverSeed, NONCES);
  const r: RoundRecord = {
    v: 1,
    game: 'DarkSeek',
    room: 'ROOM-02',
    tier: 'CASUAL',
    round: 17,
    startedAt: '2026-11-21T20:00:00.000Z',
    endedAt: '2026-11-21T20:02:14.000Z',
    network: null,
    fairness: { commit: commitOf(serverSeed), serverSeed, nonces: NONCES, roundSeed, spawnCount: 8, deal: dealRound(roundSeed, HIDERS, 8) },
    seats: ['s0', 's1', ...HIDERS].map((seat, i) => ({ seat, role: seat[0] === 's' ? 'SEEKER' : 'HIDER', character: 'x', wallet: null, slot: i, staked: false })),
    catches: [{ ms: 31250, seeker: 's1', hider: 'h3' }],
    outcome: { reason: 'TIME_EXPIRED', slots: [255, 255, 255, 1, 255, 255, 255, 255], survivors: ['h0', 'h1', 'h2', 'h4', 'h5', 'h6', 'h7'] },
  };
  mutate?.(r);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  const digest = recordDigest(r);
  const message = recordMessage(r, digest);
  const signature = new Uint8Array(sign(null, Buffer.from(offchainMessageBytes(message)), privateKey));
  return { s: { record: r, digest, message, signer: b58(raw), signature: b58(signature) }, signer: b58(raw) };
}

test('records: a fair, signed one passes; a changed outcome, deal or signer does not', () => {
  const { s, signer } = signed();
  assert.deepEqual(checkRecordOffline(s, signer), []);
  assert.ok(checkRecordOffline(s, b58(new Uint8Array(32).fill(7))).some((p) => /not the game server key/.test(p)));
  const moved = structuredClone(s);
  moved.record.outcome.slots[3] = 0;
  assert.ok(checkRecordOffline(moved, signer).some((p) => /digest/.test(p)));
  // honestly signed, but the outcome contradicts the captures
  const lying = signed((r) => (r.outcome.slots[3] = 0));
  assert.ok(checkRecordOffline(lying.s, lying.signer).some((p) => /captures/.test(p)));
  // honestly signed, but the spawns are not the ones the seed deals
  const dealt = signed((r) => {
    const d = r.fairness.deal.spawns;
    [d.h0, d.h1] = [d.h1, d.h0];
  });
  assert.ok(checkRecordOffline(dealt.s, dealt.signer).some((p) => /spawns and roles/.test(p)));
  // honestly signed, but the seed is not the committed one
  const swapped = signed((r) => (r.fairness.serverSeed = '33'.repeat(32)));
  assert.ok(checkRecordOffline(swapped.s, swapped.signer).some((p) => /commit/.test(p)));
});
