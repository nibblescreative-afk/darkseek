// TEST ONLY. Makes a token shaped like a pump.fun mint, for local validators
// and devnet tests: one billion tokens with six decimals, no freeze authority,
// the mint authority removed in the same transaction that mints the supply,
// and on Token 2022 the metadata stored in the mint.
//
// Real $DS is created by pump.fun at launch; this script never creates it.
// Its mint is published in docs/deployments.md.
//
//   npx tsx scripts/test-ds-mint.ts --rpc <url> --payer <keypair file> [--token-2022] [--to <owner>]
//
// It refuses mainnet. The whole supply goes to --to (default: the payer).

import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import {
  AUTHORITY_TYPE,
  DS_TOTAL_SUPPLY,
  MINT_SIZE,
  MINT_WITH_POINTER_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ata,
  checkDsMint,
  splIxs,
  tokenMetadataSize,
} from '../packages/sdk/src/index.js';
import { clusterOf, flags, loadKeypair, required, send } from './lib.js';

async function main() {
  const f = flags();
  const conn = new Connection(required(f, 'rpc'), 'confirmed');
  const cluster = await clusterOf(conn, false);
  const payer = loadKeypair(required(f, 'payer'));
  const to = typeof f.to === 'string' ? new PublicKey(f.to) : payer.publicKey;
  const program = f['token-2022'] === true ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const mint = Keypair.generate();

  const create =
    program === TOKEN_PROGRAM_ID
      ? [
          SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, lamports: await conn.getMinimumBalanceForRentExemption(MINT_SIZE), space: MINT_SIZE, programId: program }),
          splIxs.initializeMint2(mint.publicKey, 6, payer.publicKey, program),
        ]
      : await (async () => {
          const meta = { name: 'DarkSeek test', symbol: 'DSTEST', uri: 'https://example.invalid/test-ds.json' };
          const lamports = await conn.getMinimumBalanceForRentExemption(MINT_WITH_POINTER_SIZE + tokenMetadataSize(meta));
          return [
            SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, lamports, space: MINT_WITH_POINTER_SIZE, programId: program }),
            splIxs.initializeMetadataPointer(mint.publicKey, null, mint.publicKey),
            splIxs.initializeMint2(mint.publicKey, 6, payer.publicKey, program),
            splIxs.initializeTokenMetadata(mint.publicKey, payer.publicKey, payer.publicKey, meta),
          ];
        })();
  const signature = await send(
    conn,
    [
      ...create,
      splIxs.createAtaIdempotent(payer.publicKey, to, mint.publicKey, program),
      splIxs.mintTo(mint.publicKey, ata(to, mint.publicKey, program), payer.publicKey, DS_TOTAL_SUPPLY, program),
      splIxs.setAuthority(mint.publicKey, payer.publicKey, AUTHORITY_TYPE.MintTokens, null, program),
    ],
    [payer, mint],
  );
  const report = await checkDsMint(conn, mint.publicKey);
  for (const c of report.checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}: ${c.detail}`);
  if (!report.ok) throw new Error('the test mint does not pass the $DS checks');
  console.log(JSON.stringify({ test: true, cluster, mint: mint.publicKey.toBase58(), tokenProgram: program.toBase58(), holder: to.toBase58(), signature }, null, 2));
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`test-ds-mint: ${(err as Error).message}`);
    process.exit(1);
  },
);
