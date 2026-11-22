import { PublicKey } from '@solana/web3.js';

/**
 * The program id this source declares (`declare_id!`): the devnet and testnet
 * deployments listed in docs/deployments.md. Every builder and check also
 * takes the program id as an argument.
 */
export const PROGRAM_ID = new PublicKey('DarkHJqM8GMmCu7BWko6HMG4YgJgZ7jeEr2Qe967e5sE');

export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const BPF_LOADER_UPGRADEABLE_ID = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

export const SEATS = 10;
export const SEEKER_SEATS = 2;
export const HIDER_SEATS = 8;
/** Settle outcome for a Hider still free when the hunt ended. */
export const SURVIVED = 0xff;
export const STATUS = { OPEN: 0, LIVE: 1, SETTLED: 2 } as const;
export const ROOMS = 6;
export const TIER = { CASUAL: 0, PRO: 1 } as const;
/** Rooms 1 to 3 are casual, 4 to 6 pro (the setup script creates them so). */
export const roomTier = (room: number): number => (room <= 3 ? TIER.CASUAL : TIER.PRO);

export const BPS = 10_000n;
export const DAY = 86_400;
export const MAX_SESSION_SECS = 90 * DAY;
export const STALE_AFTER_SECS = 2 * 3_600;
/** a seated player may leave an open lobby on their own once it has been forming this long */
export const LEAVE_AFTER_SECS = 30 * 60;
export const REWARD_SCALE = 1_000_000_000_000n;
/** of the stakers' USDC that waited, at most a tenth goes out at each round start */
export const CARRY_RELEASE_DIV = 10n;
export const AUCTION_RESTART_BPS = 15_000n;
/** a fill this soon after the one before restarts the price at 3 times instead of 1.5 */
export const QUICK_REFILL_SECS = 10 * 60;
/** the bounds init_ds puts on the auction settings: each leg of the descent lasts six hours to seven days */
export const MIN_AUCTION_SECS = 21_600n;
export const MAX_AUCTION_SECS = 7n * 86_400n;
export const MAX_LOT_USDC = 100_000n;
export const MAX_BUYBACK_TARGET_USDC = 1_000_000n;
/** after each completed buyback round the next target is 98% of the last */
export const BUYBACK_TARGET_DECAY_BPS = 9_800n;

export const USDC_DECIMALS = 6;
export const USDC_UNIT = 1_000_000n;

/** $DS: created by pump.fun with one billion tokens, six decimals, no mint or freeze authority. */
export const DS_DECIMALS = 6;
export const DS_UNIT = 1_000_000n;
export const DS_TOTAL_SUPPLY = 1_000_000_000n * DS_UNIT;
/**
 * Circle's USDC on Solana mainnet: SPL Token, six decimals. Circle holds its mint
 * and freeze authorities. A mainnet deployment must stake this mint and no other.
 */
export const MAINNET_USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

/** The published protocol parameters (white paper); `checkConfig` compares the chain with them. */
export const PUBLISHED = {
  feeBps: 1_000,
  /** basis points of the fee: 10%, 20%, 20%, 50% (1%, 2%, 2% and 5% of every stake) */
  split: { stakers: 1_000, rebate: 2_000, buyback: 2_000, treasury: 5_000 },
  /** [casual Hider, casual Seeker, pro Hider, pro Seeker] in USDC base units */
  stakes: [500_000n, 1_500_000n, 2_500_000n, 7_500_000n] as const,
  /** the first buyback target is half the USDC value of the launch buy (3% of supply) */
  buybackTargetShareBps: 5_000,
} as const;

export type Cluster = 'devnet' | 'testnet' | 'mainnet-beta' | 'localnet';

export interface Deployment {
  cluster: Cluster;
  programId: PublicKey;
  /** the stake token: USDC, or a test token with no value on devnet and testnet */
  usdcMint: PublicKey;
  /** null until $DS exists on that cluster; on testnet a test only token shaped like a pump.fun mint */
  dsMint: PublicKey | null;
}

/**
 * Official deployments, as published in docs/deployments.md. Devnet and
 * testnet stake a test token with no value (the same mint address on both);
 * there is no mainnet deployment yet.
 */
export const DEPLOYMENTS: Partial<Record<Cluster, Deployment>> = {
  devnet: {
    cluster: 'devnet',
    programId: PROGRAM_ID,
    /** test USDC: six decimals, no value, handed out by the game */
    usdcMint: new PublicKey('34EifEmt9oXcyPNzCWEFjpp9nieq1XvgZKLKRuv1VZhj'),
    dsMint: null,
  },
  testnet: {
    cluster: 'testnet',
    programId: PROGRAM_ID,
    /** the same test USDC address as on devnet */
    usdcMint: new PublicKey('34EifEmt9oXcyPNzCWEFjpp9nieq1XvgZKLKRuv1VZhj'),
    /** TEST ONLY: made by scripts/test-ds-mint.ts and recorded by init_ds; it is not $DS */
    dsMint: new PublicKey('6SrLNa3d3gZJaWNyLvhWvqCSbvfZYSgw3LDQ1WW3PbSw'),
  },
};
