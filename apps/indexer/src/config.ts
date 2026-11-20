import { PublicKey, type Finality } from '@solana/web3.js';
import { PROGRAM_ID, type Cluster } from '@darkseek/sdk';

export interface IndexerConfig {
  rpcUrl: string;
  programId: PublicKey;
  cluster: Cluster;
  dbPath: string;
  port: number;
  host: string;
  /** finalized by default: an indexed event never rolls back */
  commitment: Finality;
  pollMs: number;
  /** how long /solvency results are reused */
  solvencyCacheMs: number;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): IndexerConfig {
  const commitment = (env.DS_COMMITMENT ?? 'finalized') as Finality;
  if (commitment !== 'finalized' && commitment !== 'confirmed') throw new Error('DS_COMMITMENT must be finalized or confirmed');
  return {
    rpcUrl: env.DS_RPC_URL ?? 'https://api.devnet.solana.com',
    programId: new PublicKey(env.DS_PROGRAM_ID ?? PROGRAM_ID),
    cluster: (env.DS_CLUSTER ?? 'devnet') as Cluster,
    dbPath: env.DS_DB_PATH ?? 'data/indexer.sqlite',
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? '0.0.0.0',
    commitment,
    pollMs: Number(env.DS_POLL_MS ?? 2_000),
    solvencyCacheMs: Number(env.DS_SOLVENCY_CACHE_MS ?? 30_000),
  };
}
