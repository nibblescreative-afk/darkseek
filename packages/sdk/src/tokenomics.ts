// Room economics and settlement in USDC (decimal numbers), as players see them.
// The same rules as the program (rules.ts has the base unit version the chain
// runs); the tests check that both agree on every outcome.

export type RoomTier = 'CASUAL' | 'PRO';

export interface RoomTierEconomics {
  tier: RoomTier;
  label: string;
  hiderStakeUsdc: number;
  seekerStakeUsdc: number;
  hiderSlots: number;
  seekerSlots: number;
  totalGrossUsdc: number;
  protocolRevenueUsdc: number;
  netPoolUsdc: number;
}

export const ROOM_ECONOMICS: Record<RoomTier, RoomTierEconomics> = {
  CASUAL: {
    tier: 'CASUAL',
    label: 'Casual Room (Tier 1)',
    hiderStakeUsdc: 0.5,
    seekerStakeUsdc: 1.5,
    hiderSlots: 8,
    seekerSlots: 2,
    totalGrossUsdc: 7.0,
    protocolRevenueUsdc: 0.7,
    netPoolUsdc: 6.3,
  },
  PRO: {
    tier: 'PRO',
    label: 'Pro Room (Tier 2)',
    hiderStakeUsdc: 2.5,
    seekerStakeUsdc: 7.5,
    hiderSlots: 8,
    seekerSlots: 2,
    totalGrossUsdc: 35.0,
    protocolRevenueUsdc: 3.5,
    netPoolUsdc: 31.5,
  },
};

/** The protocol fee taken from every stake when the round starts, and how it is shared (basis points of the fee). */
export const PROTOCOL_FEE_BPS = 1_000; // 10% of every stake
export const FEE_SPLIT_BPS = {
  stakers: 1_000, // 10% of the fee, 1% of every stake: $DS stakers, in USDC, pro rata
  loserRebate: 2_000, // 20% of the fee, 2% of every stake: players who lost money, paid in $DS
  buybackBurn: 2_000, // 20% of the fee, 2% of every stake: buys $DS in the auction and burns it
  treasury: 5_000, // 50% of the fee, 5% of every stake: treasury
} as const;

export interface RevenueSplit {
  totalRevenueUsdc: number;
  stakingPoolUsdc: number; // 10% of the fee
  losingPlayersDsValueUsdc: number; // 20% of the fee, credited to the round's losers and paid in $DS
  buybackBurnUsdc: number; // 20% of the fee, buys back $DS and burns it
  treasuryUsdc: number; // 50% of the fee (and whatever rounding leaves)
}

export function calculateProtocolRevenueSplit(totalGrossUsdc: number): RevenueSplit {
  const totalRevenueUsdc = roundUsdc((totalGrossUsdc * PROTOCOL_FEE_BPS) / 10_000);
  const share = (bps: number) => roundUsdc((totalRevenueUsdc * bps) / 10_000);
  const stakingPoolUsdc = share(FEE_SPLIT_BPS.stakers);
  const losingPlayersDsValueUsdc = share(FEE_SPLIT_BPS.loserRebate);
  const buybackBurnUsdc = share(FEE_SPLIT_BPS.buybackBurn);
  // the treasury takes the rest, so the four parts always add up to the fee exactly
  const treasuryUsdc = roundUsdc(totalRevenueUsdc - stakingPoolUsdc - losingPlayersDsValueUsdc - buybackBurnUsdc);
  return { totalRevenueUsdc, stakingPoolUsdc, losingPlayersDsValueUsdc, buybackBurnUsdc, treasuryUsdc };
}

export interface SeekerPerformanceInput {
  id: string;
  name: string;
  kills: number;
}

export interface HiderPerformanceInput {
  id: string;
  name: string;
  survived: boolean;
}

export interface MatchSettlementResult {
  tier: RoomTier;
  netPoolUsdc: number;
  revenueSplit: RevenueSplit;
  /** Seekers win only when no Hider survives the round. */
  seekersWon: boolean;
  netHiderStakeUsdc: number;
  netSeekerStakeUsdc: number;
  seekerResults: {
    id: string;
    name: string;
    kills: number;
    stakeReturnedUsdc: number;
    lootEarnedUsdc: number; // net stake of every Hider this Seeker caught
    totalPayoutUsdc: number;
    netPnlUsdc: number;
    rebateUsdc: number; // rebate credit, paid in $DS the rebate pool buys
  }[];
  hiderResults: {
    id: string;
    name: string;
    survived: boolean;
    survivalShareUsdc: number; // own net stake back
    forfeitedSeekerBonusUsdc: number; // equal share of both Seekers' stakes when the Hiders win
    totalPayoutUsdc: number;
    netPnlUsdc: number;
    rebateUsdc: number; // rebate credit, paid in $DS the rebate pool buys
  }[];
}

/**
 * DarkSeek settlement:
 * - 10% protocol fee is taken when the round starts, so every stake in the pool is a 90% net stake.
 * - Every Seeker keeps the net stake of each Hider they personally caught, win or lose.
 * - Seekers win only if no Hider survives. Then each Seeker also gets their own net stake back.
 * - Otherwise the Hiders win: survivors get their own net stake back and split both Seekers'
 *   net stakes evenly. Caught Hiders lose their stake to the Seeker who caught them.
 * - Players who lost money (caught Hiders, Seekers who ended below their stake) share the
 *   rebate (20% of the fee) equally, as USDC credit paid in $DS that the rebate pool buys.
 */
export function settleDarkSeekMatch(tier: RoomTier, seekers: SeekerPerformanceInput[], hiders: HiderPerformanceInput[]): MatchSettlementResult {
  const econ = ROOM_ECONOMICS[tier];
  const revenueSplit = calculateProtocolRevenueSplit(econ.totalGrossUsdc);
  const netHiderStake = roundUsdc(econ.hiderStakeUsdc * 0.9);
  const netSeekerStake = roundUsdc(econ.seekerStakeUsdc * 0.9);

  const survivingHiders = hiders.filter((h) => h.survived);
  const capturedCount = hiders.length - survivingHiders.length;
  const seekersWon = hiders.length > 0 && survivingHiders.length === 0;

  // catches can never pay out more Hider stakes than were actually lost
  let lootLeft = capturedCount;
  const paidKills = seekers.map((s) => {
    const k = Math.max(0, Math.min(Math.floor(s.kills), lootLeft));
    lootLeft -= k;
    return k;
  });

  const seekerResults = seekers.map((seeker, i) => {
    const stakeReturnedUsdc = seekersWon ? netSeekerStake : 0;
    const lootEarnedUsdc = roundUsdc(paidKills[i] * netHiderStake);
    const totalPayoutUsdc = roundUsdc(stakeReturnedUsdc + lootEarnedUsdc);
    return {
      id: seeker.id,
      name: seeker.name,
      kills: seeker.kills,
      stakeReturnedUsdc,
      lootEarnedUsdc,
      totalPayoutUsdc,
      netPnlUsdc: roundUsdc(totalPayoutUsdc - econ.seekerStakeUsdc),
      rebateUsdc: 0,
    };
  });

  const seekerPool = seekersWon ? 0 : roundUsdc(netSeekerStake * seekers.length);
  const bonusPerSurvivor = survivingHiders.length > 0 ? floorUsdc(seekerPool / survivingHiders.length) : 0;

  const hiderResults = hiders.map((hider) => {
    const survivalShareUsdc = hider.survived ? netHiderStake : 0;
    const forfeitedSeekerBonusUsdc = hider.survived ? bonusPerSurvivor : 0;
    const totalPayoutUsdc = roundUsdc(survivalShareUsdc + forfeitedSeekerBonusUsdc);
    return {
      id: hider.id,
      name: hider.name,
      survived: hider.survived,
      survivalShareUsdc,
      forfeitedSeekerBonusUsdc,
      totalPayoutUsdc,
      netPnlUsdc: roundUsdc(totalPayoutUsdc - econ.hiderStakeUsdc),
      rebateUsdc: 0,
    };
  });

  const losers = [...seekerResults.filter((s) => s.netPnlUsdc < 0), ...hiderResults.filter((h) => h.netPnlUsdc < 0)];
  if (losers.length > 0) {
    const each = floorUsdc(revenueSplit.losingPlayersDsValueUsdc / losers.length);
    for (const l of losers) l.rebateUsdc = each;
  }

  return { tier, netPoolUsdc: econ.netPoolUsdc, revenueSplit, seekersWon, netHiderStakeUsdc: netHiderStake, netSeekerStakeUsdc: netSeekerStake, seekerResults, hiderResults };
}

/** What one player got out of a settled round. */
export interface PlayerSettlementBreakdown {
  role: 'SEEKER' | 'HIDER';
  seekersWon: boolean;
  stakeUsdc: number;
  ownStakeBackUsdc: number;
  lootUsdc: number;
  kills: number;
  survivorShareUsdc: number;
  totalPayoutUsdc: number;
  netPnlUsdc: number;
  /** rebate credit, paid in $DS */
  rebateUsdc: number;
}

export function playerBreakdown(r: MatchSettlementResult, role: 'SEEKER' | 'HIDER', playerId: string): PlayerSettlementBreakdown {
  const econ = ROOM_ECONOMICS[r.tier];
  if (role === 'SEEKER') {
    const row = r.seekerResults.find((x) => x.id === playerId);
    if (!row) throw new Error(`no Seeker ${playerId}`);
    return {
      role,
      seekersWon: r.seekersWon,
      stakeUsdc: econ.seekerStakeUsdc,
      ownStakeBackUsdc: row.stakeReturnedUsdc,
      lootUsdc: row.lootEarnedUsdc,
      kills: row.kills,
      survivorShareUsdc: 0,
      totalPayoutUsdc: row.totalPayoutUsdc,
      netPnlUsdc: row.netPnlUsdc,
      rebateUsdc: row.rebateUsdc,
    };
  }
  const row = r.hiderResults.find((x) => x.id === playerId);
  if (!row) throw new Error(`no Hider ${playerId}`);
  return {
    role,
    seekersWon: r.seekersWon,
    stakeUsdc: econ.hiderStakeUsdc,
    ownStakeBackUsdc: row.survivalShareUsdc,
    lootUsdc: 0,
    kills: 0,
    survivorShareUsdc: row.forfeitedSeekerBonusUsdc,
    totalPayoutUsdc: row.totalPayoutUsdc,
    netPnlUsdc: row.netPnlUsdc,
    rebateUsdc: row.rebateUsdc,
  };
}

export interface LiveEarningsEstimate {
  estimatedUsdc: number;
  netPnlUsdc: number;
  /** true when, if the round ended now, this player's side would be winning */
  winning: boolean;
}

/** What a player would be paid if the round ended now (the in game earnings counter). */
export function calculateLiveMatchEarnings(input: { tier: RoomTier; role: 'SEEKER' | 'HIDER'; alive: boolean; kills: number; aliveHidersCount: number }): LiveEarningsEstimate {
  const econ = ROOM_ECONOMICS[input.tier];
  const netHiderStake = roundUsdc(econ.hiderStakeUsdc * 0.9);
  const netSeekerStake = roundUsdc(econ.seekerStakeUsdc * 0.9);
  const allCaught = input.aliveHidersCount <= 0;
  if (input.role === 'SEEKER') {
    const stakeBack = allCaught ? netSeekerStake : 0;
    const loot = roundUsdc(Math.min(econ.hiderSlots, Math.max(0, input.kills)) * netHiderStake);
    const total = roundUsdc(stakeBack + loot);
    return { estimatedUsdc: total, netPnlUsdc: roundUsdc(total - econ.seekerStakeUsdc), winning: allCaught };
  }
  const survivors = Math.max(input.alive ? 1 : 0, input.aliveHidersCount);
  const bonus = input.alive && survivors > 0 ? floorUsdc((netSeekerStake * econ.seekerSlots) / survivors) : 0;
  const total = input.alive ? roundUsdc(netHiderStake + bonus) : 0;
  return { estimatedUsdc: total, netPnlUsdc: roundUsdc(total - econ.hiderStakeUsdc), winning: input.alive };
}

export function calculateStakeSharePercent(userStakedDs: number, totalStakedDs: number): number {
  if (totalStakedDs <= 0 || userStakedDs <= 0) return 0;
  return Number(((userStakedDs / totalStakedDs) * 100).toFixed(2));
}

/** Rounds to the USDC base unit (6 decimals). */
export function roundUsdc(val: number): number {
  return Math.round(val * 1_000_000) / 1_000_000;
}

/** Rounds down to the USDC base unit (6 decimals), as the program does. */
export function floorUsdc(val: number): number {
  return Math.floor(val * 1_000_000 + 1e-6) / 1_000_000;
}

