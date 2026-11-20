#!/usr/bin/env node
// darkseek-verify: checks a DarkSeek deployment from the outside, with nothing
// but an RPC endpoint. See docs/verify.md.

import { readFileSync } from 'node:fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { DEPLOYMENTS, PROGRAM_ID, type Cluster } from './constants.js';
import { checkCharacterNft, checkDsMint, checkSolvency, configChecks, executableHash, fetchConfig, fetchProgramInfo, isUnset, toReport, type Check, type Report } from './verify.js';
import { accountUrl } from './explorer.js';

const USAGE = `usage: darkseek-verify [all|config|solvency|program|ds-mint|nft] [options]

  --program <id>             the deployment's program id (see docs/deployments.md)
  --usdc-mint <mint>         config: the stake token the deployment publishes
  --ds-mint <mint>           config, ds-mint: the published $DS mint
  --launch-buy-usdc <units>  config: the USDC value of the launch buy published in
                             deployments.md (the first buyback target is half of it)
  --cluster <devnet|mainnet-beta|localnet>   default devnet
  --rpc <url>                default: the cluster's public endpoint
  --so <file>                program: compare with a release .so
  --upgrade-authority <key>  program: the published upgrade authority
  --mint <key>               nft: the character mint to check
  --update-authority <key>   nft: the published metadata update authority
  --json                     print the reports as JSON

Without --program, the official deployment for the cluster is used, as
published in docs/deployments.md (on localnet, the id in the source); any
other cluster without one needs --program.`;

function args(argv: string[]) {
  const out: { command: string; flags: Record<string, string | true> } = { command: 'all', flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out.flags[a.slice(2)] = next;
        i++;
      } else out.flags[a.slice(2)] = true;
    } else out.command = a;
  }
  return out;
}

const RPC: Record<Cluster, string> = {
  devnet: 'https://api.devnet.solana.com',
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
  localnet: 'http://127.0.0.1:8899',
};

async function main(): Promise<number> {
  const { command, flags } = args(process.argv.slice(2));
  if (flags.help || flags.h) {
    console.log(USAGE);
    return 0;
  }
  const str = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined);
  const cluster = (str('cluster') ?? 'devnet') as Cluster;
  if (!(cluster in RPC)) throw new Error(`unknown cluster ${cluster}`);
  const official = DEPLOYMENTS[cluster];
  const conn = new Connection(str('rpc') ?? RPC[cluster], 'confirmed');
  const programArg = str('program');
  // a local validator runs the program at the id the source declares (scripts/localnet.sh)
  const local = cluster === 'localnet' ? PROGRAM_ID : undefined;
  if (!programArg && !official && !local) throw new Error(`no official deployment on ${cluster} yet: pass --program <id>`);
  const programId = new PublicKey(programArg ?? official?.programId ?? local!);
  const source = programArg ? 'given' : official ? 'official deployment' : 'the id in the source, on a local validator';
  const usdcMint = str('usdc-mint') ?? (programArg ? undefined : official?.usdcMint.toBase58());
  const dsMint = str('ds-mint') ?? (programArg ? undefined : official?.dsMint?.toBase58());
  const sections: [string, Report][] = [];

  if (command === 'all' || command === 'config') {
    const config = await fetchConfig(conn, programId);
    const launchBuy = str('launch-buy-usdc');
    const checks: Check[] = configChecks(config, {
      ...(usdcMint ? { usdcMint: new PublicKey(usdcMint) } : {}),
      ...(dsMint ? { dsMint: new PublicKey(dsMint) } : {}),
      ...(launchBuy ? { launchBuyUsdc: BigInt(launchBuy) } : {}),
    });
    if (!usdcMint) checks.push({ name: 'stake token (pass --usdc-mint to compare)', ok: true, warn: true, detail: config.mint.toBase58() });
    if (!dsMint) checks.push({ name: '$DS mint recorded (pass --ds-mint to compare)', ok: true, warn: true, detail: isUnset(config.dsMint) ? 'none' : config.dsMint.toBase58() });
    if (!isUnset(config.dsMint)) {
      checks.push({ name: 'buyback', ok: true, warn: true, detail: `${config.buybacksDone} round(s) done; next spends ${config.buybackTarget} once the pool (${config.buybackPool}) reaches it` });
    }
    checks.push({ name: 'admin', ok: true, warn: true, detail: config.admin.toBase58() });
    checks.push({ name: 'game server key', ok: true, warn: true, detail: config.authority.toBase58() });
    sections.push(['Settings', toReport(checks)]);
    if (command === 'all' && !isUnset(config.dsMint)) sections.push(['$DS mint', await checkDsMint(conn, config.dsMint)]);
  }
  if (command === 'all' || command === 'solvency') {
    sections.push(['Solvency', await checkSolvency(conn, programId)]);
  }
  if (command === 'all' || command === 'program') {
    const info = await fetchProgramInfo(conn, programId);
    const checks: Check[] = [{ name: 'deployed program hash', ok: true, warn: true, detail: info.hash }];
    const so = str('so');
    if (so) {
      const local = executableHash(readFileSync(so));
      checks.push({ name: `matches ${so}`, ok: local === info.hash, detail: local });
    }
    const ua = str('upgrade-authority');
    if (ua) checks.push({ name: 'upgrade authority is the published one', ok: !!info.upgradeAuthority?.equals(new PublicKey(ua)), detail: info.upgradeAuthority?.toBase58() ?? 'none (immutable)' });
    else checks.push({ name: 'upgrade authority', ok: true, warn: true, detail: info.upgradeAuthority?.toBase58() ?? 'none (immutable)' });
    sections.push(['Program', toReport(checks)]);
  }
  if (command === 'ds-mint') {
    if (!dsMint) throw new Error('--ds-mint is required');
    sections.push(['$DS mint', await checkDsMint(conn, new PublicKey(dsMint))]);
  }
  if (command === 'nft') {
    const mint = str('mint');
    if (!mint) throw new Error('--mint is required');
    const ua = str('update-authority');
    sections.push(['Character NFT', await checkCharacterNft(conn, new PublicKey(mint), ua ? { updateAuthority: new PublicKey(ua) } : {})]);
  }
  if (!sections.length) {
    console.error(USAGE);
    return 2;
  }

  const ok = sections.every(([, r]) => r.ok);
  if (flags.json) {
    console.log(JSON.stringify({ cluster, programId: programId.toBase58(), programIdSource: source, ok, sections: Object.fromEntries(sections) }, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    return ok ? 0 : 1;
  }
  console.log(`DarkSeek verification on ${cluster}`);
  console.log(`program ${programId.toBase58()} (${source})`);
  if (cluster !== 'localnet') console.log(accountUrl(programId, cluster));
  console.log('');
  let failed = 0;
  for (const [title, r] of sections) {
    console.log(title);
    for (const c of r.checks) {
      const mark = c.ok ? (c.warn ? 'info' : 'ok  ') : c.warn ? 'warn' : 'FAIL';
      if (!c.ok && !c.warn) failed++;
      console.log(`  ${mark}  ${c.name}: ${c.detail}`);
    }
    console.log('');
  }
  console.log(ok ? 'All checks passed.' : `${failed} check(s) failed.`);
  return ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`darkseek-verify: ${(err as Error).message}`);
    process.exit(2);
  },
);
