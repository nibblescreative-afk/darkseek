// Sets the vault program up on a cluster, as its admin. Safe to run again:
// every step is skipped when it is already done.
//
//   npx tsx scripts/setup-cluster.ts --rpc <url> --admin <upgrade authority keypair file>
//       --authority <game server pubkey> --usdc <USDC mint>
//       [--ds-mint <$DS mint> --buyback-target <USDC base units> --genesis-price <$DS base units per USDC>]
//       [--floor-price <...>] [--auction-hours 6] [--lot <USDC base units>] [--min-fill <USDC base units>]
//       [--program <id>] [--mainnet]
//   on a local validator, --create-test-usdc makes a test USDC mint instead of --usdc
//
// Steps: initialize (published stakes, 10% fee split 10/20/20/50), rooms 1 to
// 3 casual and 4 to 6 pro, then init_ds once $DS exists. For the launch:
//   --buyback-target  half the USDC value of the launch buy (3% of supply)
//   --genesis-price   $DS the launch buy got per USDC
//   --floor-price     defaults to a thousandth of the genesis price: the
//                     auction never pays more than 1000 times the launch price
// All of these go into docs/deployments.md with the conversion used.

import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { MINT_SIZE, PROGRAM_ID, PUBLISHED, TOKEN_PROGRAM_ID, VaultInstructions, decodeConfig, pda, roomTier, splIxs, type DsArgs } from '../packages/sdk/src/index.js';
import { clusterOf, flags, loadKeypair, required, send, whole } from './lib.js';

async function main() {
  const f = flags();
  const conn = new Connection(required(f, 'rpc'), 'confirmed');
  const cluster = await clusterOf(conn, f.mainnet === true);
  const admin = loadKeypair(required(f, 'admin'));
  const programId = new PublicKey(typeof f.program === 'string' ? f.program : PROGRAM_ID);
  const ix = new VaultInstructions(programId);
  const log = (s: string) => console.log(s);

  let usdc: PublicKey;
  if (f['create-test-usdc'] === true) {
    if (cluster !== 'local') throw new Error('--create-test-usdc is for a local validator');
    const mint = Keypair.generate();
    const rent = await conn.getMinimumBalanceForRentExemption(MINT_SIZE);
    await send(conn, [SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: mint.publicKey, lamports: rent, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }), splIxs.initializeMint2(mint.publicKey, 6, admin.publicKey)], [admin, mint]);
    usdc = mint.publicKey;
    log(`test USDC ${usdc.toBase58()} (the admin may mint it)`);
  } else usdc = new PublicKey(required(f, 'usdc'));

  if (!(await conn.getAccountInfo(pda.config(programId)))) {
    const authority = new PublicKey(required(f, 'authority'));
    await send(
      conn,
      [ix.initialize(admin.publicKey, usdc, { authority, stakes: [...PUBLISHED.stakes] as [bigint, bigint, bigint, bigint], feeBps: PUBLISHED.feeBps, split: { ...PUBLISHED.split } })],
      [admin],
    );
    log(`config initialized: game server ${authority.toBase58()}`);
  } else log('config exists');

  const rooms = await conn.getMultipleAccountsInfo([1, 2, 3, 4, 5, 6].map((i) => pda.room(i, programId)));
  const missing = rooms.flatMap((r, i) => (r ? [] : [i + 1]));
  if (missing.length) {
    await send(conn, missing.map((i) => ix.initRoom(admin.publicKey, i, roomTier(i))), [admin]);
    log(`rooms ${missing.join(', ')} created`);
  } else log('rooms exist');

  if (typeof f['ds-mint'] === 'string') {
    const dsMint = new PublicKey(f['ds-mint']);
    const config = decodeConfig((await conn.getAccountInfo(pda.config(programId)))!.data);
    if (config.dsMint.equals(PublicKey.default)) {
      const mintInfo = await conn.getAccountInfo(dsMint);
      if (!mintInfo) throw new Error('no such $DS mint');
      const genesisPrice = BigInt(required(f, 'genesis-price'));
      const args: DsArgs = {
        buybackTarget: BigInt(required(f, 'buyback-target')),
        genesisPrice,
        floorPrice: typeof f['floor-price'] === 'string' ? BigInt(f['floor-price']) : genesisPrice / 1_000n > 0n ? genesisPrice / 1_000n : 1n,
        duration: BigInt(Math.round(Number(typeof f['auction-hours'] === 'string' ? f['auction-hours'] : 6) * 3_600)),
        lot: BigInt(typeof f.lot === 'string' ? f.lot : 1_000_000_000),
        minFill: BigInt(typeof f['min-fill'] === 'string' ? f['min-fill'] : 1_000_000),
      };
      await send(conn, [ix.initDs(admin.publicKey, dsMint, args, mintInfo.owner)], [admin]);
      log(`$DS ${dsMint.toBase58()} recorded (${mintInfo.owner.toBase58()}); first buyback round spends ${whole(args.buybackTarget)} USDC`);
    } else if (!config.dsMint.equals(dsMint)) throw new Error(`a different $DS mint is recorded: ${config.dsMint.toBase58()}`);
    else log('$DS already recorded');
  }
  log(`done on ${cluster}: program ${programId.toBase58()}, USDC ${usdc.toBase58()}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`setup-cluster: ${(err as Error).message}`);
    process.exit(1);
  },
);
