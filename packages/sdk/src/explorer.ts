// Links to Solscan for transactions, accounts and tokens.

import type { PublicKey } from '@solana/web3.js';
import type { Cluster } from './constants.js';

export type ExplorerKind = 'tx' | 'account' | 'token';

/**
 * A Solscan link (devnet and mainnet). A local validator has no public
 * explorer, so localnet links open the Solana Explorer on a custom RPC.
 */
export function explorerUrl(kind: ExplorerKind, id: string | PublicKey, cluster: Cluster = 'devnet', localRpc = 'http://127.0.0.1:8899'): string {
  const value = typeof id === 'string' ? id : id.toBase58();
  if (cluster === 'localnet') {
    const path = kind === 'tx' ? 'tx' : 'address';
    return `https://explorer.solana.com/${path}/${value}?cluster=custom&customUrl=${encodeURIComponent(localRpc)}`;
  }
  const query = cluster === 'devnet' ? '?cluster=devnet' : '';
  return `https://solscan.io/${kind}/${value}${query}`;
}

export const txUrl = (signature: string, cluster: Cluster = 'devnet') => explorerUrl('tx', signature, cluster);
export const accountUrl = (address: string | PublicKey, cluster: Cluster = 'devnet') => explorerUrl('account', address, cluster);
export const tokenUrl = (mint: string | PublicKey, cluster: Cluster = 'devnet') => explorerUrl('token', mint, cluster);
