import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';
import {
  DS_TOTAL_SUPPLY,
  EXT,
  STATUS,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  dsMintChecks,
  executableHash,
  explorerUrl,
  nftChecks,
  solvencyFrom,
  type ConfigAccount,
  type RoomAccount,
  type VaultAccount,
} from '../src/index.js';

const key = () => Keypair.generate().publicKey;
const Z = PublicKey.default;

function mintData(o: { authority?: PublicKey | null; freeze?: PublicKey | null; supply: bigint; decimals: number }): Buffer {
  const b = Buffer.alloc(82);
  if (o.authority) {
    b.writeUInt32LE(1, 0);
    o.authority.toBuffer().copy(b, 4);
  }
  b.writeBigUInt64LE(o.supply, 36);
  b[44] = o.decimals;
  b[45] = 1;
  if (o.freeze) {
    b.writeUInt32LE(1, 46);
    o.freeze.toBuffer().copy(b, 50);
  }
  return b;
}

const tlv = (type: number, value: Buffer) => {
  const h = Buffer.alloc(4);
  h.writeUInt16LE(type, 0);
  h.writeUInt16LE(value.length, 2);
  return Buffer.concat([h, value]);
};
const str = (s: string) => {
  const l = Buffer.alloc(4);
  l.writeUInt32LE(Buffer.byteLength(s));
  return Buffer.concat([l, Buffer.from(s)]);
};

function nftData(mint: PublicKey, o: { supply?: bigint; authority?: PublicKey | null; updateAuthority?: PublicKey; extra?: Buffer[]; pointerTo?: PublicKey } = {}): Buffer {
  const base = mintData({ authority: o.authority ?? null, supply: o.supply ?? 1n, decimals: 0 });
  const padded = Buffer.concat([base, Buffer.alloc(165 - 82), Buffer.from([1])]);
  const pointer = tlv(EXT.MetadataPointer, Buffer.concat([Z.toBuffer(), (o.pointerTo ?? mint).toBuffer()]));
  const meta = tlv(EXT.TokenMetadata, Buffer.concat([(o.updateAuthority ?? Z).toBuffer(), mint.toBuffer(), str('Smokey #007'), str('DSC'), str('https://example.invalid/nft/1.json'), Buffer.alloc(4)]));
  return Buffer.concat([padded, pointer, meta, ...(o.extra ?? [])]);
}

test('$DS: fixed supply, nothing can mint or freeze', () => {
  const good = dsMintChecks({ owner: TOKEN_PROGRAM_ID, data: mintData({ supply: DS_TOTAL_SUPPLY, decimals: 6 }) });
  assert.ok(good.every((c) => c.ok), JSON.stringify(good));
  const mintable = dsMintChecks({ owner: TOKEN_PROGRAM_ID, data: mintData({ authority: key(), supply: DS_TOTAL_SUPPLY, decimals: 6 }) });
  assert.ok(mintable.some((c) => !c.ok && /mint authority/.test(c.name)));
  const freezable = dsMintChecks({ owner: TOKEN_PROGRAM_ID, data: mintData({ freeze: key(), supply: DS_TOTAL_SUPPLY, decimals: 6 }) });
  assert.ok(freezable.some((c) => !c.ok && /freeze/.test(c.name)));
  // pump.fun may create $DS on Token 2022, with its metadata in the mint
  const mint = key();
  const withMetadata = Buffer.concat([mintData({ supply: DS_TOTAL_SUPPLY, decimals: 6 }), Buffer.alloc(165 - 82), Buffer.from([1]), tlv(EXT.MetadataPointer, Buffer.concat([Z.toBuffer(), mint.toBuffer()]))]);
  assert.ok(dsMintChecks({ owner: TOKEN_2022_PROGRAM_ID, data: withMetadata }).every((c) => c.ok));
  const withDelegate = Buffer.concat([withMetadata, tlv(EXT.PermanentDelegate, key().toBuffer())]);
  assert.ok(dsMintChecks({ owner: TOKEN_2022_PROGRAM_ID, data: withDelegate }).some((c) => !c.ok && /PermanentDelegate/.test(c.detail)));
  const inflated = dsMintChecks({ owner: TOKEN_PROGRAM_ID, data: mintData({ supply: DS_TOTAL_SUPPLY + 1n, decimals: 6 }) });
  assert.ok(inflated.some((c) => !c.ok && /supply/.test(c.name)));
  const burned = dsMintChecks({ owner: TOKEN_PROGRAM_ID, data: mintData({ supply: DS_TOTAL_SUPPLY - 5n, decimals: 6 }) });
  assert.ok(burned.every((c) => c.ok));
  assert.equal(burned.find((c) => c.name === 'burned so far')?.detail, '5');
});

test('character NFT: Token 2022, one of one, metadata in the mint, nothing harmful', () => {
  const mint = key();
  const ua = key();
  const ok = nftChecks(mint, { owner: TOKEN_2022_PROGRAM_ID, data: nftData(mint, { updateAuthority: ua }) }, { updateAuthority: ua, symbol: 'DSC' });
  assert.ok(ok.every((c) => c.ok), JSON.stringify(ok, null, 1));
  const two = nftChecks(mint, { owner: TOKEN_2022_PROGRAM_ID, data: nftData(mint, { supply: 2n }) });
  assert.ok(two.some((c) => !c.ok && /supply/.test(c.name)));
  const mintable = nftChecks(mint, { owner: TOKEN_2022_PROGRAM_ID, data: nftData(mint, { authority: key() }) });
  assert.ok(mintable.some((c) => !c.ok && /mint authority/.test(c.name)));
  const delegate = nftChecks(mint, { owner: TOKEN_2022_PROGRAM_ID, data: nftData(mint, { extra: [tlv(EXT.PermanentDelegate, key().toBuffer())] }) });
  assert.ok(delegate.some((c) => !c.ok && /PermanentDelegate/.test(c.detail)));
  const elsewhere = nftChecks(mint, { owner: TOKEN_2022_PROGRAM_ID, data: nftData(mint, { pointerTo: key() }) });
  assert.ok(elsewhere.some((c) => !c.ok && /pointer/.test(c.name)));
  const classic = nftChecks(mint, { owner: TOKEN_PROGRAM_ID, data: mintData({ supply: 1n, decimals: 0 }) });
  assert.ok(!classic[0].ok);
});

function books() {
  const owners = [key(), key()];
  const config = {
    treasury: 350_000n,
    stakerPool: 70_000n,
    rebatePool: 140_000n,
    buybackPool: 140_000n,
    dsReserve: 1_000n,
    reserveCost: 30_000n,
    rebateCredits: 150_000n,
    dsStaked: 50n,
    rewardPerDs: 0n,
  } as unknown as ConfigAccount;
  const vaults: VaultAccount[] = owners.map((owner, i) => ({
    owner,
    balance: 1_000_000n * BigInt(i + 1),
    locked: i === 0 ? 500_000n : 0n,
    sessionExpires: 0n,
    dailyCap: 0n,
    spentDay: 0n,
    spent: 0n,
    dsBalance: 10n,
    dsStaked: 25n,
    rewardIndex: 0n,
    rewards: 0n,
    rebateCredit: 75_000n,
    bump: 255,
  }));
  const seats = Array.from({ length: 10 }, (_, s) => ({ owner: s === 2 ? owners[0] : Z, stake: s === 2 ? 500_000n : 0n }));
  const rooms: RoomAccount[] = [{ index: 1, tier: 0, status: STATUS.OPEN, bump: 255, round: 3n, pot: 500_000n, fee: 0n, rebate: 0n, startedAt: 0n, updatedAt: 0n, seats }];
  const owed = 3_000_000n + 500_000n + 350_000n + 70_000n + 140_000n + 140_000n;
  return { config, vaults, rooms, owed, dsOwed: 1_000n + 20n + 50n };
}

test('solvency: custody must cover every balance the program owes', () => {
  const b = books();
  const ok = solvencyFrom({ config: b.config, custody: b.owed, dsCustody: b.dsOwed, vaults: b.vaults, rooms: b.rooms });
  assert.ok(ok.ok, JSON.stringify(ok.checks));
  assert.equal(ok.usdc.surplus, 0n);
  const short = solvencyFrom({ config: b.config, custody: b.owed - 1n, dsCustody: b.dsOwed, vaults: b.vaults, rooms: b.rooms });
  assert.ok(!short.ok);
  const dsShort = solvencyFrom({ config: b.config, custody: b.owed, dsCustody: b.dsOwed - 1n, vaults: b.vaults, rooms: b.rooms });
  assert.ok(!dsShort.ok);
  // a pot that does not match its seats, or a stake locked with no seat, is reported
  b.rooms[0].pot += 1n;
  assert.ok(solvencyFrom({ config: b.config, custody: b.owed + 1n, dsCustody: b.dsOwed, vaults: b.vaults, rooms: b.rooms }).checks.some((c) => !c.ok && /room 1 pot/.test(c.name)));
  b.rooms[0].pot -= 1n;
  b.vaults[1].locked = 1n;
  assert.ok(solvencyFrom({ config: b.config, custody: b.owed, dsCustody: b.dsOwed, vaults: b.vaults, rooms: b.rooms }).checks.some((c) => !c.ok && /locked/.test(c.name)));
  b.vaults[1].locked = 0n;
  // rebate credits must add up and stay covered by the rebate pool and what it bought
  b.vaults[0].rebateCredit += 1n;
  assert.ok(solvencyFrom({ config: b.config, custody: b.owed, dsCustody: b.dsOwed, vaults: b.vaults, rooms: b.rooms }).checks.some((c) => !c.ok && /credits add up/.test(c.name)));
  b.vaults[0].rebateCredit -= 1n;
  b.config.rebateCredits = 170_001n;
  b.vaults[0].rebateCredit = 95_001n;
  assert.ok(solvencyFrom({ config: b.config, custody: b.owed, dsCustody: b.dsOwed, vaults: b.vaults, rooms: b.rooms }).checks.some((c) => !c.ok && /cover every rebate/.test(c.name)));
});

test('program hash ignores trailing zero padding, like solana-verify', () => {
  const elf = Buffer.from('7f454c46020101', 'hex');
  assert.equal(executableHash(elf), executableHash(Buffer.concat([elf, Buffer.alloc(4096)])));
  assert.notEqual(executableHash(elf), executableHash(Buffer.from('7f454c46020102', 'hex')));
});

test('explorer links go to Solscan', () => {
  assert.equal(explorerUrl('tx', 'abc', 'devnet'), 'https://solscan.io/tx/abc?cluster=devnet');
  assert.equal(explorerUrl('account', 'xyz', 'mainnet-beta'), 'https://solscan.io/account/xyz');
  assert.equal(explorerUrl('token', 'mint', 'devnet'), 'https://solscan.io/token/mint?cluster=devnet');
  assert.equal(explorerUrl('tx', 'abc', 'testnet'), 'https://solscan.io/tx/abc?cluster=testnet');
  assert.match(explorerUrl('tx', 'abc', 'localnet'), /explorer\.solana\.com\/tx\/abc\?cluster=custom/);
});
