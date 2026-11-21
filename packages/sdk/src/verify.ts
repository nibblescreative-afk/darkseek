// Checks anyone can run against the chain: the program's books (solvency), its
// settings against the white paper, the deployed bytecode against a release,
// the $DS mint (fixed supply) and character NFTs (Token 2022, one of one).

import { PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import { ACCOUNT_DISCRIMINATORS, ACCOUNT_SIZES, decodeConfig, decodeRoom, decodeVault, type ConfigAccount, type RoomAccount, type VaultAccount } from './accounts.js';
import { BPF_LOADER_UPGRADEABLE_ID, DS_DECIMALS, DS_TOTAL_SUPPLY, PROGRAM_ID, PUBLISHED, ROOMS, STATUS, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './constants.js';
import { pda } from './pda.js';
import { buybackTargetAfter, dsArgsOk, earned } from './rules.js';
import { EXT, EXT_NAME, decodeMetadataPointer, decodeMint, decodeTokenAccount, decodeTokenMetadata } from './spl.js';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** a failed warning is worth a look but does not fail the report */
  warn?: boolean;
}

export interface Report {
  ok: boolean;
  checks: Check[];
}

const report = (checks: Check[]): Report => ({ ok: checks.every((c) => c.ok || c.warn), checks });
const show = (k: PublicKey | null) => (k ? k.toBase58() : 'none');
/** The all zero key the program stores for "not set". */
export const isUnset = (k: PublicKey) => k.equals(PublicKey.default);

// ---------------------------------------------------------------------- solvency

export interface SolvencyReport extends Report {
  usdc: {
    custody: bigint;
    owed: bigint;
    surplus: bigint;
    vaultBalances: bigint;
    roomPots: bigint;
    treasury: bigint;
    stakerPool: bigint;
    rebatePool: bigint;
    buybackPool: bigint;
  };
  ds: { custody: bigint; owed: bigint; surplus: bigint; reserve: bigint; vaultBalances: bigint; staked: bigint } | null;
  vaults: number;
}

/**
 * The solvency rules from docs/solvency.md, on decoded accounts:
 *  1. USDC custody >= every vault balance + every room pot + treasury + staker, rebate and buyback pools
 *  2. $DS custody >= the reserve + every vault's free and staked $DS
 *  3. each room's pot matches its seats; locked stakes match the seats of open and live rooms
 *  4. staked $DS adds up; the staker pool covers every staker's rewards
 *  5. rebate credits add up, and the rebate pool plus what it paid for the reserve covers them
 */
export function solvencyFrom(input: { config: ConfigAccount; custody: bigint; dsCustody: bigint | null; vaults: VaultAccount[]; rooms: RoomAccount[] }): SolvencyReport {
  const { config: c, vaults, rooms } = input;
  const checks: Check[] = [];
  const sum = (xs: bigint[]) => xs.reduce((s, x) => s + x, 0n);

  const vaultBalances = sum(vaults.map((v) => v.balance));
  const roomPots = sum(rooms.map((r) => r.pot));
  const owed = vaultBalances + roomPots + c.treasury + c.stakerPool + c.rebatePool + c.buybackPool;
  checks.push({ name: 'USDC custody covers everything owed', ok: input.custody >= owed, detail: `custody ${input.custody}, owed ${owed}` });

  let ds: SolvencyReport['ds'] = null;
  if (input.dsCustody !== null) {
    const dsBalances = sum(vaults.map((v) => v.dsBalance));
    const dsStaked = sum(vaults.map((v) => v.dsStaked));
    const dsOwed = c.dsReserve + dsBalances + dsStaked;
    ds = { custody: input.dsCustody, owed: dsOwed, surplus: input.dsCustody - dsOwed, reserve: c.dsReserve, vaultBalances: dsBalances, staked: dsStaked };
    checks.push({ name: '$DS custody covers the reserve and every vault', ok: input.dsCustody >= dsOwed, detail: `custody ${input.dsCustody}, owed ${dsOwed}` });
    checks.push({ name: 'staked $DS adds up', ok: dsStaked === c.dsStaked, detail: `vaults ${dsStaked}, config ${c.dsStaked}` });
  }

  let seated = 0n;
  for (const r of rooms) {
    const stakes = sum(r.seats.map((s) => s.stake));
    const expected = r.status === STATUS.OPEN ? stakes : r.status === STATUS.LIVE ? stakes - r.fee : 0n;
    if (r.status !== STATUS.SETTLED) seated += stakes;
    checks.push({ name: `room ${r.index} pot matches its seats`, ok: r.pot === expected, detail: `status ${r.status}, pot ${r.pot}, expected ${expected}` });
  }
  const locked = sum(vaults.map((v) => v.locked));
  checks.push({ name: 'locked stakes match the seats of open and live rooms', ok: locked === seated, detail: `vaults ${locked}, seats ${seated}` });

  const rewardsOwed = sum(vaults.map((v) => v.rewards + earned(v.dsStaked, c.rewardPerDs, v.rewardIndex)));
  checks.push({ name: 'staker pool covers every staker', ok: c.stakerPool >= rewardsOwed, detail: `pool ${c.stakerPool}, owed ${rewardsOwed}` });

  const credits = sum(vaults.map((v) => v.rebateCredit));
  checks.push({ name: 'rebate credits add up', ok: credits === c.rebateCredits, detail: `vaults ${credits}, config ${c.rebateCredits}` });
  checks.push({
    name: 'rebate pool and reserve cover every rebate credit',
    ok: c.rebatePool + c.reserveCost >= c.rebateCredits,
    detail: `pool ${c.rebatePool} + reserve cost ${c.reserveCost}, credits ${c.rebateCredits}`,
  });

  return {
    ...report(checks),
    usdc: { custody: input.custody, owed, surplus: input.custody - owed, vaultBalances, roomPots, treasury: c.treasury, stakerPool: c.stakerPool, rebatePool: c.rebatePool, buybackPool: c.buybackPool },
    ds,
    vaults: vaults.length,
  };
}

/** Every vault of the program (one getProgramAccounts call). */
export async function fetchVaults(conn: Connection, programId: PublicKey = PROGRAM_ID): Promise<VaultAccount[]> {
  const list = await conn.getProgramAccounts(programId, { filters: [{ dataSize: ACCOUNT_SIZES.Vault }] });
  return list.filter((a) => Buffer.from(a.account.data.subarray(0, 8)).equals(ACCOUNT_DISCRIMINATORS.Vault)).map((a) => decodeVault(a.account.data));
}

export async function fetchConfig(conn: Connection, programId: PublicKey = PROGRAM_ID): Promise<ConfigAccount> {
  const info = await conn.getAccountInfo(pda.config(programId));
  if (!info) throw new Error('the program is not initialized on this cluster');
  if (!info.owner.equals(programId)) throw new Error('config is not owned by the program');
  return decodeConfig(info.data);
}

export async function fetchRooms(conn: Connection, programId: PublicKey = PROGRAM_ID): Promise<RoomAccount[]> {
  const keys = Array.from({ length: ROOMS }, (_, i) => pda.room(i + 1, programId));
  const infos = await conn.getMultipleAccountsInfo(keys);
  return infos.filter((i): i is AccountInfo<Buffer> => !!i && i.owner.equals(programId)).map((i) => decodeRoom(i.data));
}

async function tokenAmount(conn: Connection, account: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(account);
  return info ? decodeTokenAccount(info.data).amount : 0n;
}

/** Reads the whole program state and checks the solvency rules. */
export async function checkSolvency(conn: Connection, programId: PublicKey = PROGRAM_ID): Promise<SolvencyReport> {
  const config = await fetchConfig(conn, programId);
  const [custody, dsCustody, vaults, rooms] = await Promise.all([
    tokenAmount(conn, config.custody),
    isUnset(config.dsMint) ? Promise.resolve(null) : tokenAmount(conn, config.dsCustody),
    fetchVaults(conn, programId),
    fetchRooms(conn, programId),
  ]);
  return solvencyFrom({ config, custody, dsCustody, vaults, rooms });
}

// ---------------------------------------------------------------------- settings

export interface ExpectedSettings {
  usdcMint?: PublicKey;
  dsMint?: PublicKey | null;
  admin?: PublicKey;
  authority?: PublicKey;
  /** USDC value (base units) of the launch buy published in deployments.md: the first target is half of it */
  launchBuyUsdc?: bigint;
}

/** Compares the onchain config with the published parameters and, if given, the published addresses. */
export function configChecks(c: ConfigAccount, expected: ExpectedSettings = {}): Check[] {
  const checks: Check[] = [];
  checks.push({ name: 'protocol fee is 10%', ok: c.feeBps === PUBLISHED.feeBps, detail: `${c.feeBps} bps` });
  const s = c.split;
  const p = PUBLISHED.split;
  checks.push({
    name: 'fee split is 10% stakers, 20% rebate, 20% buyback, 50% treasury (of the fee)',
    ok: s.stakers === p.stakers && s.rebate === p.rebate && s.buyback === p.buyback && s.treasury === p.treasury,
    detail: `${s.stakers}/${s.rebate}/${s.buyback}/${s.treasury} bps of the fee`,
  });
  checks.push({
    name: 'stakes are 0.5/1.5 casual and 2.5/7.5 pro',
    ok: c.stakes.length === 4 && c.stakes.every((x, i) => x === PUBLISHED.stakes[i]),
    detail: c.stakes.map(String).join(', '),
  });
  if (expected.usdcMint) checks.push({ name: 'stake token is the published USDC mint', ok: c.mint.equals(expected.usdcMint), detail: c.mint.toBase58() });
  if (expected.dsMint !== undefined) {
    const recorded = isUnset(c.dsMint) ? null : c.dsMint;
    const ok = expected.dsMint === null ? recorded === null : !!recorded && recorded.equals(expected.dsMint);
    checks.push({ name: 'recorded $DS mint is the published one', ok, detail: show(recorded) });
  }
  if (!isUnset(c.dsMint)) {
    const due = buybackTargetAfter(c.buybackTargetInitial, c.buybacksDone);
    checks.push({
      name: 'buyback target is the first target times 0.98 per completed round',
      ok: c.buybackTarget === due,
      detail: `target ${c.buybackTarget} after ${c.buybacksDone} round(s) from ${c.buybackTargetInitial}`,
    });
    if (expected.launchBuyUsdc !== undefined) {
      const half = (expected.launchBuyUsdc * BigInt(PUBLISHED.buybackTargetShareBps)) / 10_000n;
      checks.push({ name: 'first buyback target is half the launch buy', ok: c.buybackTargetInitial === half, detail: `${c.buybackTargetInitial}, half of ${expected.launchBuyUsdc} is ${half}` });
    }
    // the bounds release v0.4.0 puts on init_ds (a deployment recorded before it is held to them here)
    const a = c.auction;
    const unit = 10n ** BigInt(c.decimals);
    const filled = c.totals.buybackSpent > 0n || c.totals.rebateSpent > 0n;
    const bounded = dsArgsOk(
      { genesisPrice: filled ? a.floorPrice : a.lastPrice, floorPrice: a.floorPrice, duration: a.duration, lot: a.lot, minFill: a.minFill, buybackTarget: c.buybackTargetInitial },
      unit,
    );
    checks.push({
      name: 'auction settings are within the bounds: floor at least a thousandth of the genesis price, a descent of 1 hour to 7 days, a lot of at most 100,000 USDC, a first target of at most 1,000,000 USDC',
      ok: bounded,
      detail: `floor ${a.floorPrice}${filled ? '' : `, genesis ${a.lastPrice}`}, ${a.duration} s, lot ${a.lot}, min fill ${a.minFill}, first target ${c.buybackTargetInitial}`,
    });
  } else {
    // from v0.4.0 the whole fee goes to the treasury until $DS is recorded; anything here came in earlier
    const waiting = c.stakerPool + c.rebatePool + c.buybackPool;
    checks.push({ name: 'no fee waits in the staker, rebate or buyback pool before $DS is recorded', ok: waiting === 0n, warn: true, detail: `staker ${c.stakerPool}, rebate ${c.rebatePool}, buyback ${c.buybackPool}` });
  }
  if (expected.admin) checks.push({ name: 'admin is the published key', ok: c.admin.equals(expected.admin), detail: c.admin.toBase58() });
  if (expected.authority) checks.push({ name: 'game server key is the published one', ok: c.authority.equals(expected.authority), detail: c.authority.toBase58() });
  const pending = isUnset(c.pendingAdmin) ? null : c.pendingAdmin;
  checks.push({ name: 'no admin handover pending', ok: pending === null, detail: show(pending), warn: true });
  return checks;
}

export async function checkConfig(conn: Connection, programId: PublicKey = PROGRAM_ID, expected: ExpectedSettings = {}): Promise<Report> {
  return report(configChecks(await fetchConfig(conn, programId), expected));
}

// ---------------------------------------------------------------------- bytecode

/** sha256 of program bytes with trailing zero bytes removed (what solana-verify reports). */
export function executableHash(bytes: Uint8Array): string {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return bytesToHex(sha256(bytes.subarray(0, end)));
}

export interface ProgramInfo {
  programData: PublicKey;
  upgradeAuthority: PublicKey | null;
  deploySlot: bigint;
  hash: string;
}

/** The deployed program's hash and upgrade authority (upgradeable loader only). */
export async function fetchProgramInfo(conn: Connection, programId: PublicKey = PROGRAM_ID): Promise<ProgramInfo> {
  const program = await conn.getAccountInfo(programId);
  if (!program) throw new Error('no such program');
  if (!program.owner.equals(BPF_LOADER_UPGRADEABLE_ID) || program.data.readUInt32LE(0) !== 2) throw new Error('not an upgradeable program');
  const programData = new PublicKey(program.data.subarray(4, 36));
  const pd = await conn.getAccountInfo(programData);
  if (!pd || pd.data.readUInt32LE(0) !== 3) throw new Error('program data account missing');
  const deploySlot = pd.data.readBigUInt64LE(4);
  const upgradeAuthority = pd.data[12] === 1 ? new PublicKey(pd.data.subarray(13, 45)) : null;
  return { programData, upgradeAuthority, deploySlot, hash: executableHash(pd.data.subarray(45)) };
}

// ---------------------------------------------------------------------- $DS

/** Extensions a $DS mint may carry: its own metadata, nothing else. */
const DS_ALLOWED_EXTENSIONS: number[] = [EXT.MetadataPointer, EXT.TokenMetadata];

/**
 * $DS must have six decimals, a fixed supply and nobody able to mint or
 * freeze. pump.fun creates it on SPL Token or on Token 2022; a Token 2022
 * mint may carry metadata and no other extension.
 */
export function dsMintChecks(info: { owner: PublicKey; data: Uint8Array }, opts: { totalSupply?: bigint } = {}): Check[] {
  const checks: Check[] = [];
  const isToken = info.owner.equals(TOKEN_PROGRAM_ID) || info.owner.equals(TOKEN_2022_PROGRAM_ID);
  checks.push({ name: '$DS is an SPL Token or Token 2022 mint', ok: isToken, detail: info.owner.toBase58() });
  if (!isToken) return checks;
  const m = decodeMint(info.data, info.owner);
  checks.push({ name: 'mint authority revoked (no more $DS can ever be minted)', ok: m.mintAuthority === null, detail: show(m.mintAuthority) });
  checks.push({ name: 'no freeze authority (nobody can freeze holders)', ok: m.freezeAuthority === null, detail: show(m.freezeAuthority) });
  checks.push({ name: 'six decimals', ok: m.decimals === DS_DECIMALS, detail: String(m.decimals) });
  const total = opts.totalSupply ?? DS_TOTAL_SUPPLY;
  checks.push({ name: 'supply at most the fixed total (lower only by burns)', ok: m.supply <= total && m.supply > 0n, detail: `${m.supply} of ${total}` });
  checks.push({ name: 'burned so far', ok: true, detail: String(total - m.supply), warn: true });
  const extra = [...m.extensions.keys()].filter((k) => !DS_ALLOWED_EXTENSIONS.includes(k));
  checks.push({ name: 'no extension but metadata', ok: extra.length === 0, detail: extra.length ? extra.map((k) => EXT_NAME[k] ?? k).join(', ') : [...m.extensions.keys()].map((k) => EXT_NAME[k]).join(', ') || 'none' });
  return checks;
}

export async function checkDsMint(conn: Connection, mint: PublicKey, opts: { totalSupply?: bigint } = {}): Promise<Report> {
  const info = await conn.getAccountInfo(mint);
  if (!info) return report([{ name: '$DS mint exists', ok: false, detail: mint.toBase58() }]);
  return report(dsMintChecks(info, opts));
}

// ---------------------------------------------------------------------- character NFTs

/** Extensions that would let someone take, freeze, tax or lock a character after it is sold. */
const HARMFUL_FOR_NFT = [EXT.PermanentDelegate, EXT.TransferHook, EXT.TransferFeeConfig, EXT.NonTransferable, EXT.DefaultAccountState, EXT.Pausable, EXT.ConfidentialTransferMint, EXT.MintCloseAuthority];

/**
 * A character is a Token 2022 mint with supply 1, no decimals, no mint or
 * freeze authority, and its metadata stored in the mint itself.
 */
export function nftChecks(mint: PublicKey, info: { owner: PublicKey; data: Uint8Array }, opts: { updateAuthority?: PublicKey; symbol?: string } = {}): Check[] {
  const checks: Check[] = [];
  const is2022 = info.owner.equals(TOKEN_2022_PROGRAM_ID);
  checks.push({ name: 'Token 2022 mint', ok: is2022, detail: info.owner.toBase58() });
  if (!is2022) return checks;
  const m = decodeMint(info.data, info.owner);
  checks.push({ name: 'supply is exactly 1', ok: m.supply === 1n, detail: String(m.supply) });
  checks.push({ name: 'no decimals', ok: m.decimals === 0, detail: String(m.decimals) });
  checks.push({ name: 'mint authority removed (no second copy can exist)', ok: m.mintAuthority === null, detail: show(m.mintAuthority) });
  checks.push({ name: 'no freeze authority', ok: m.freezeAuthority === null, detail: show(m.freezeAuthority) });
  const harmful = HARMFUL_FOR_NFT.filter((t) => m.extensions.has(t));
  checks.push({ name: 'no extension that could take, freeze, tax or lock it', ok: harmful.length === 0, detail: harmful.length ? harmful.map((t) => EXT_NAME[t]).join(', ') : 'none' });
  const pointer = m.extensions.get(EXT.MetadataPointer);
  const p = pointer ? decodeMetadataPointer(pointer) : null;
  checks.push({ name: 'metadata pointer points at the mint itself', ok: !!p?.metadataAddress?.equals(mint), detail: show(p?.metadataAddress ?? null) });
  const raw = m.extensions.get(EXT.TokenMetadata);
  if (!raw) {
    checks.push({ name: 'metadata stored in the mint', ok: false, detail: 'missing' });
    return checks;
  }
  const md = decodeTokenMetadata(raw);
  checks.push({ name: 'metadata stored in the mint', ok: md.mint.equals(mint), detail: `${md.name} (${md.symbol}) ${md.uri}` });
  if (opts.symbol) checks.push({ name: `symbol is ${opts.symbol}`, ok: md.symbol === opts.symbol, detail: md.symbol });
  if (opts.updateAuthority) {
    checks.push({ name: 'metadata update authority is the published key', ok: !!md.updateAuthority?.equals(opts.updateAuthority), detail: show(md.updateAuthority) });
  } else {
    checks.push({ name: 'metadata update authority', ok: true, detail: show(md.updateAuthority), warn: true });
  }
  return checks;
}

export async function checkCharacterNft(conn: Connection, mint: PublicKey, opts: { updateAuthority?: PublicKey; symbol?: string } = {}): Promise<Report> {
  const info = await conn.getAccountInfo(mint);
  if (!info) return report([{ name: 'NFT mint exists', ok: false, detail: mint.toBase58() }]);
  return report(nftChecks(mint, info, opts));
}

export { report as toReport };
