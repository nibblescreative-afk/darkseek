// $DS on either token program through the real scripts, the checks init_ds and
// token locks make on Token 2022 mints, and the NFT checks against real Token
// 2022 mints, on a local validator.
//
// Run: scripts/build-program.sh && npx tsx --test tests/token.test.ts

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair, PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';
import {
  AUTHORITY_TYPE,
  DS_TOTAL_SUPPLY,
  MINT_NON_TRANSFERABLE_SIZE,
  MINT_WITH_DELEGATE_SIZE,
  MINT_WITH_POINTER_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ata,
  checkCharacterNft,
  checkDsMint,
  checkSolvency,
  configChecks,
  fetchConfig,
  ixs,
  splIxs,
  tokenMetadataSize,
  type DsArgs,
} from '../packages/sdk/src/index.js';
import { ROOT, ValidatorChain } from './harness/chain.js';
import { expectError } from './harness/world.js';

let chain: ValidatorChain;
let dir: string;
const admin = Keypair.generate();
const server = Keypair.generate();
const tsx = path.join(ROOT, 'node_modules/.bin/tsx');
const U = 1_000_000n;
const ARGS: DsArgs = { genesisPrice: 100n * U, floorPrice: U, duration: 21_600n, lot: 1_000n * U, minFill: U, buybackTarget: 150n * U };

function run(script: string, args: string[]) {
  const r = spawnSync(tsx, [path.join(ROOT, 'scripts', script), ...args], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, `${script} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

before(async () => {
  chain = await ValidatorChain.start(admin.publicKey, Number(process.env.DS_TEST_PORT_TOKEN ?? 29_899));
  await chain.airdrop(admin.publicKey, 50);
  // throwaway keys for this local validator only, outside the repository
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkseek-token-test-'));
  fs.writeFileSync(path.join(dir, 'admin.json'), JSON.stringify([...admin.secretKey]));
});

after(async () => {
  await chain?.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  setTimeout(() => process.exit(), 500).unref();
});

/** A Token 2022 mint with one extension, the full supply minted to the admin and the mint authority removed. */
async function mint2022(space: number, extension: (mint: PublicKey) => TransactionInstruction): Promise<PublicKey> {
  const mint = Keypair.generate();
  await chain.send(
    [
      SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: mint.publicKey, lamports: await chain.rent(space), space, programId: TOKEN_2022_PROGRAM_ID }),
      extension(mint.publicKey),
      splIxs.initializeMint2(mint.publicKey, 6, admin.publicKey, TOKEN_2022_PROGRAM_ID),
      splIxs.createAtaIdempotent(admin.publicKey, admin.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
      splIxs.mintTo(mint.publicKey, ata(admin.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID), admin.publicKey, DS_TOTAL_SUPPLY, TOKEN_2022_PROGRAM_ID),
      splIxs.setAuthority(mint.publicKey, admin.publicKey, AUTHORITY_TYPE.MintTokens, null, TOKEN_2022_PROGRAM_ID),
    ],
    [admin, mint],
  );
  return mint.publicKey;
}

test('the test mint script makes a pump.fun shaped token on either token program', async () => {
  for (const flag of [[], ['--token-2022']]) {
    const out = run('test-ds-mint.ts', ['--rpc', chain.rpcUrl, '--payer', path.join(dir, 'admin.json'), ...flag]);
    const made = JSON.parse(out.slice(out.indexOf('{'))) as { mint: string; tokenProgram: string; test: boolean };
    assert.equal(made.test, true);
    assert.equal(made.tokenProgram, (flag.length ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID).toBase58());
    const report = await checkDsMint(chain.conn, new PublicKey(made.mint));
    assert.ok(report.ok, JSON.stringify(report.checks));
  }
});

let dsMint: PublicKey;

test('init_ds and token locks refuse Token 2022 mints that could take, freeze or block tokens', async () => {
  // the program has to be set up before $DS can be recorded
  run('setup-cluster.ts', ['--rpc', chain.rpcUrl, '--admin', path.join(dir, 'admin.json'), '--authority', server.publicKey.toBase58(), '--create-test-usdc']);
  const delegate = await mint2022(MINT_WITH_DELEGATE_SIZE, (m) => splIxs.initializePermanentDelegate(m, admin.publicKey));
  const frozen = await mint2022(MINT_NON_TRANSFERABLE_SIZE, (m) => splIxs.initializeNonTransferableMint(m));
  for (const bad of [delegate, frozen]) {
    await expectError(chain.send([ixs.initDs(admin.publicKey, bad, ARGS, TOKEN_2022_PROGRAM_ID)], [admin]), 'MintExtensionNotAllowed');
    assert.equal((await checkDsMint(chain.conn, bad)).ok, false, 'and the SDK says so too');
  }
  // the generic lock refuses them as well: a delegate could empty it
  const beneficiary = Keypair.generate().publicKey;
  await expectError(
    chain.send([ixs.createVesting(admin.publicKey, beneficiary, delegate, { id: 1n, total: U, start: 0n, cliff: 0n, end: 1n }, TOKEN_2022_PROGRAM_ID)], [admin]),
    'MintExtensionNotAllowed',
  );
  assert.ok((await fetchConfig(chain.conn)).dsMint.equals(PublicKey.default), 'nothing recorded');
});

test('setup-cluster records a pump.fun shaped $DS with its buyback target, once', async () => {
  const out = run('test-ds-mint.ts', ['--rpc', chain.rpcUrl, '--payer', path.join(dir, 'admin.json'), '--token-2022']);
  dsMint = new PublicKey((JSON.parse(out.slice(out.indexOf('{'))) as { mint: string }).mint);
  // as if the launch buy had been worth 300 USDC: the first round spends 150
  const args = ['--rpc', chain.rpcUrl, '--admin', path.join(dir, 'admin.json'), '--authority', server.publicKey.toBase58(), '--usdc', (await fetchConfig(chain.conn)).mint.toBase58()];
  run('setup-cluster.ts', [...args, '--ds-mint', dsMint.toBase58(), '--buyback-target', String(150n * U), '--genesis-price', String(100_000n * U)]);
  const config = await fetchConfig(chain.conn);
  assert.ok(configChecks(config, { dsMint, admin: admin.publicKey, authority: server.publicKey, launchBuyUsdc: 300n * U }).every((c) => c.ok));
  assert.ok(config.dsTokenProgram.equals(TOKEN_2022_PROGRAM_ID));
  assert.deepEqual([config.buybackTarget, config.buybackTargetInitial, config.buybacksDone], [150n * U, 150n * U, 0n]);
  assert.equal(config.auction.floorPrice, 1n, 'no fixed limit: the descent follows the last fill');
  // running it again changes nothing, and nobody can record a second target
  run('setup-cluster.ts', [...args, '--ds-mint', dsMint.toBase58()]);
  await expectError(chain.send([ixs.initDs(admin.publicKey, dsMint, { ...ARGS, buybackTarget: 999n * U }, TOKEN_2022_PROGRAM_ID)], [admin]), /already in use|DsAlreadySet/);
  assert.equal((await fetchConfig(chain.conn)).buybackTarget, 150n * U);
  const solvency = await checkSolvency(chain.conn);
  assert.ok(solvency.ok);
  assert.equal(solvency.ds?.surplus, 0n);
});

async function nft(o: { revoke: boolean }): Promise<PublicKey> {
  const mint = Keypair.generate();
  const meta = { name: 'Smokey #007', symbol: 'DSEEK', uri: 'https://example.invalid/nft/smokey-007.json' };
  const rent = await chain.rent(MINT_WITH_POINTER_SIZE + tokenMetadataSize(meta));
  const owner = Keypair.generate().publicKey;
  const ixs = [
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: mint.publicKey, lamports: rent, space: MINT_WITH_POINTER_SIZE, programId: TOKEN_2022_PROGRAM_ID }),
    splIxs.initializeMetadataPointer(mint.publicKey, null, mint.publicKey),
    splIxs.initializeMint2(mint.publicKey, 0, admin.publicKey, TOKEN_2022_PROGRAM_ID),
    splIxs.initializeTokenMetadata(mint.publicKey, admin.publicKey, admin.publicKey, meta),
    splIxs.createAtaIdempotent(admin.publicKey, owner, mint.publicKey, TOKEN_2022_PROGRAM_ID),
    splIxs.mintTo(mint.publicKey, ata(owner, mint.publicKey, TOKEN_2022_PROGRAM_ID), admin.publicKey, 1n, TOKEN_2022_PROGRAM_ID),
  ];
  if (o.revoke) ixs.push(splIxs.setAuthority(mint.publicKey, admin.publicKey, AUTHORITY_TYPE.MintTokens, null, TOKEN_2022_PROGRAM_ID));
  await chain.send(ixs, [admin, mint]);
  return mint.publicKey;
}

test('a character NFT passes: Token 2022, one of one, metadata in the mint', async () => {
  const mint = await nft({ revoke: true });
  const report = await checkCharacterNft(chain.conn, mint, { updateAuthority: admin.publicKey, symbol: 'DSEEK' });
  assert.ok(report.ok, JSON.stringify(report.checks, null, 1));
});

test('a copy whose mint authority remains fails the check', async () => {
  const mint = await nft({ revoke: false });
  const report = await checkCharacterNft(chain.conn, mint);
  assert.equal(report.ok, false);
  assert.ok(report.checks.some((c) => !c.ok && /mint authority/.test(c.name)));
});
