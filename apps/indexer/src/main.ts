// The indexer process: follow the program, serve the API, stop cleanly.

import { Connection } from '@solana/web3.js';
import { PROGRAM_ID } from '@darkseek/sdk';
import { configFromEnv } from './config.js';
import { Store } from './store.js';
import { Follower } from './follower.js';
import { createApi } from './api.js';

const log = (level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, ...extra }));

const config = configFromEnv();
if (config.programId.equals(PROGRAM_ID)) log('info', 'following the devnet deployment (the default); set DS_PROGRAM_ID for another one');
const conn = new Connection(config.rpcUrl, config.commitment);
const store = new Store(config.dbPath);
const follower = new Follower({ conn, programId: config.programId, store, commitment: config.commitment, log });
const server = createApi({ store, follower, conn, programId: config.programId, cluster: config.cluster, solvencyCacheMs: config.solvencyCacheMs });

server.listen(config.port, config.host, () => log('info', 'listening', { port: config.port, programId: config.programId.toBase58(), rpc: config.rpcUrl.replace(/\?.*$/, '') }));
void follower.run(config.pollMs);

const stop = () => {
  log('info', 'stopping');
  follower.stop();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
