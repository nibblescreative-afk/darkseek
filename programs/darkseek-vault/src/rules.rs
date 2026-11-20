//! The money rules as pure functions: fee, fee split, payouts, losers, staking
//! rewards, rebates, the buyback target, auction price and fill, and vesting. Every instruction that moves value goes
//! through these, and the unit tests below pin them to the published numbers.

use crate::error::VaultError;
use crate::state::*;
use anchor_lang::prelude::*;

/// Fee on one stake, rounded down.
pub fn fee_on(stake: u64, fee_bps: u16) -> u64 {
    (stake as u128 * fee_bps as u128 / BPS as u128) as u64
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FeeParts {
    pub stakers: u64,
    pub rebate: u64,
    pub buyback: u64,
    pub treasury: u64,
}

/// Splits a fee four ways; the treasury takes the rounding remainder so the
/// parts always add up to `fee`.
pub fn split_fee(fee: u64, split: &FeeSplitBps) -> FeeParts {
    let part = |bps: u16| (fee as u128 * bps as u128 / BPS as u128) as u64;
    let stakers = part(split.stakers);
    let rebate = part(split.rebate);
    let buyback = part(split.buyback);
    FeeParts { stakers, rebate, buyback, treasury: fee - stakers - rebate - buyback }
}

/// What each slot is owed when a round ends. `outcomes[i]` is Hider slot 2 + i:
/// `SURVIVED`, or the Seeker slot (0 or 1) that caught it.
///
/// * Each Seeker keeps the net stake of every Hider they caught.
/// * Seekers win only if every Hider was caught; then each also gets their own net stake back.
/// * Otherwise the survivors take their own net stake back and split both Seeker stakes evenly.
pub fn payouts_for(stakes: &[u64; 4], fee_bps: u16, tier: u8, outcomes: &[u8; HIDER_SEATS]) -> Result<[u64; SEATS]> {
    let hider_stake = stakes[tier as usize * 2];
    let seeker_stake = stakes[tier as usize * 2 + 1];
    let net_hider = hider_stake - fee_on(hider_stake, fee_bps);
    let net_seeker = seeker_stake - fee_on(seeker_stake, fee_bps);
    let mut catches = [0u64; SEEKER_SEATS];
    let mut survivors = 0u64;
    for o in outcomes.iter() {
        match *o {
            SURVIVED => survivors += 1,
            k if (k as usize) < SEEKER_SEATS => catches[k as usize] += 1,
            _ => return err!(VaultError::BadOutcome),
        }
    }
    let seekers_won = survivors == 0;
    let mut out = [0u64; SEATS];
    for s in 0..SEEKER_SEATS {
        out[s] = catches[s] * net_hider + if seekers_won { net_seeker } else { 0 };
    }
    let bonus = if seekers_won { 0 } else { net_seeker * SEEKER_SEATS as u64 / survivors };
    for (i, o) in outcomes.iter().enumerate() {
        if *o == SURVIVED {
            out[SEEKER_SEATS + i] = net_hider + bonus;
        }
    }
    Ok(out)
}

/// Bit `slot` is set for every seat that ended the round with less than it staked.
pub fn losers_mask(stakes: &[u64; SEATS], payouts: &[u64; SEATS]) -> u16 {
    let mut mask = 0u16;
    for slot in 0..SEATS {
        if payouts[slot] < stakes[slot] {
            mask |= 1 << slot;
        }
    }
    mask
}

/// Turns up to `credit` USDC of rebate credit into $DS at the reserve's average
/// purchase cost (`ds_reserve` bought for `reserve_cost`), as far as the
/// reserve reaches. Returns (credit used, $DS paid), rounded in the reserve's favour.
pub fn rebate_claim(credit: u64, ds_reserve: u64, reserve_cost: u64) -> (u64, u64) {
    let usdc = credit.min(reserve_cost);
    if usdc == 0 {
        return (0, 0);
    }
    let ds = (usdc as u128 * ds_reserve as u128 / reserve_cost as u128) as u64;
    (usdc, ds)
}

// ---------------------------------------------------------------------- staking

/// Adds `amount` USDC for stakers to the accumulator. The remainder of the
/// division (and everything while nobody stakes) is carried in scaled units, so
/// the sum of every staker's rewards can never exceed what was paid in.
/// Returns (new accumulator, new carry).
pub fn accrue_rewards(acc: u128, carry: u128, total_staked: u64, amount: u64) -> Result<(u128, u128)> {
    let pending = carry.checked_add(amount as u128 * REWARD_SCALE).ok_or(VaultError::Overflow)?;
    if total_staked == 0 {
        return Ok((acc, pending));
    }
    let inc = pending / total_staked as u128;
    Ok((acc.checked_add(inc).ok_or(VaultError::Overflow)?, pending - inc * total_staked as u128))
}

/// Rewards a stake earned since its last sync.
pub fn earned(staked: u64, acc: u128, index: u128) -> Result<u64> {
    let delta = acc.checked_sub(index).ok_or(VaultError::Overflow)?;
    let v = (staked as u128).checked_mul(delta).ok_or(VaultError::Overflow)? / REWARD_SCALE;
    u64::try_from(v).map_err(|_| error!(VaultError::Overflow))
}

// ---------------------------------------------------------------------- buyback

/// What the buyback side of the auction may spend now. A round opens only when
/// the pool holds the whole target and then spends exactly the target; once
/// rounding has taken the target to zero, the pool is spent as it comes.
pub fn buyback_available(pool: u64, target: u64, round_left: u64) -> u64 {
    if target == 0 {
        return pool;
    }
    if round_left > 0 {
        return round_left.min(pool);
    }
    if pool >= target {
        target
    } else {
        0
    }
}

/// The target after a completed round: 98% of the last, rounded down.
pub fn next_buyback_target(target: u64) -> u64 {
    (target as u128 * BUYBACK_TARGET_DECAY_BPS as u128 / BPS as u128) as u64
}

/// The target after `rounds` completed rounds, from the target `init_ds` set.
pub fn buyback_target_after(initial: u64, rounds: u64) -> u64 {
    let mut t = initial;
    for _ in 0..rounds {
        if t == 0 {
            break;
        }
        t = next_buyback_target(t);
    }
    t
}

// ---------------------------------------------------------------------- auction

/// The price the auction asks at `now`: 1.5 times the last fill, falling in a
/// straight line to the floor over `duration` seconds, then staying there.
pub fn auction_price(a: &Auction, now: i64) -> u64 {
    let restart = (a.last_price as u128 * AUCTION_RESTART_BPS as u128 / BPS as u128).min(u64::MAX as u128) as u64;
    let start = restart.max(a.floor_price);
    let elapsed = now.saturating_sub(a.started_at).max(0);
    if a.duration <= 0 || elapsed >= a.duration {
        return a.floor_price;
    }
    let drop = (start - a.floor_price) as u128 * elapsed as u128 / a.duration as u128;
    start - drop as u64
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Fill {
    /// USDC paid to the seller
    pub usdc: u64,
    /// $DS taken from the seller
    pub ds: u64,
    /// the part bought with the buyback round's budget: burned
    pub ds_burned: u64,
    /// the part bought with the rebate pool: added to the reserve
    pub ds_to_reserve: u64,
    pub from_buyback: u64,
    pub from_rebate: u64,
}

/// One fill of the auction: the seller offers up to `max_ds` at `price`; the
/// program pays from what the buyback side may spend (`buyback`) and from the
/// rebate pool (`rebate`) in proportion, at most `lot`. The seller never gives
/// more $DS than the price asks (rounded in the program's favour by at most one
/// base unit).
pub fn auction_fill(price: u64, max_ds: u64, buyback: u64, rebate: u64, lot: u64, usdc_unit: u64) -> Option<Fill> {
    if price == 0 {
        return None;
    }
    let pools = buyback as u128 + rebate as u128;
    let available = pools.min(lot as u128);
    let affordable = max_ds as u128 * usdc_unit as u128 / price as u128;
    let usdc = available.min(affordable);
    if usdc == 0 {
        return None;
    }
    let ds = (usdc * price as u128).div_ceil(usdc_unit as u128);
    let from_buyback = usdc * buyback as u128 / pools;
    let from_rebate = usdc - from_buyback;
    let ds_burned = ds * from_buyback / usdc;
    Some(Fill {
        usdc: usdc as u64,
        ds: ds as u64,
        ds_burned: ds_burned as u64,
        ds_to_reserve: (ds - ds_burned) as u64,
        from_buyback: from_buyback as u64,
        from_rebate: from_rebate as u64,
    })
}

// ---------------------------------------------------------------------- vesting

/// Tokens released by `now`: none before the cliff, all from `end`, linear in between.
pub fn vested(total: u64, start: i64, cliff: i64, end: i64, now: i64) -> u64 {
    if now < cliff || now <= start {
        return 0;
    }
    if now >= end {
        return total;
    }
    (total as u128 * (now - start) as u128 / (end - start) as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    const U: u64 = 1_000_000; // one USDC
    const STAKES: [u64; 4] = [U / 2, 3 * U / 2, 5 * U / 2, 15 * U / 2];
    const SPLIT: FeeSplitBps = FeeSplitBps { stakers: 1_000, rebate: 2_000, buyback: 2_000, treasury: 5_000 };

    fn seat_stakes(tier: u8) -> [u64; SEATS] {
        let mut s = [STAKES[tier as usize * 2]; SEATS];
        s[0] = STAKES[tier as usize * 2 + 1];
        s[1] = STAKES[tier as usize * 2 + 1];
        s
    }

    #[test]
    fn fee_is_ten_percent_and_splits_exactly() {
        assert!(SPLIT.is_valid());
        let casual: u64 = seat_stakes(0).iter().map(|s| fee_on(*s, 1_000)).sum();
        let pro: u64 = seat_stakes(1).iter().map(|s| fee_on(*s, 1_000)).sum();
        assert_eq!(casual, 700_000);
        assert_eq!(pro, 3_500_000);
        assert_eq!(split_fee(casual, &SPLIT), FeeParts { stakers: 70_000, rebate: 140_000, buyback: 140_000, treasury: 350_000 });
        assert_eq!(split_fee(pro, &SPLIT), FeeParts { stakers: 350_000, rebate: 700_000, buyback: 700_000, treasury: 1_750_000 });
        for fee in [0u64, 1, 7, 99, 101, 12_345, 999_999_937, u64::MAX / 10_000] {
            let p = split_fee(fee, &SPLIT);
            assert_eq!(p.stakers + p.rebate + p.buyback + p.treasury, fee);
            assert!(p.treasury >= fee / 10_000 * 5_000);
        }
    }

    #[test]
    fn hiders_win_survivors_split_both_seeker_stakes() {
        // Seeker 0 caught Hiders 2, 3, 4; Seeker 1 caught Hider 5; four survive
        let o = [0, 0, 0, 1, SURVIVED, SURVIVED, SURVIVED, SURVIVED];
        let p = payouts_for(&STAKES, 1_000, 0, &o).unwrap();
        assert_eq!(p[0], 3 * 450_000);
        assert_eq!(p[1], 450_000);
        assert_eq!(&p[2..6], &[0, 0, 0, 0]);
        assert_eq!(&p[6..], &[450_000 + 675_000; 4]);
        assert_eq!(p.iter().sum::<u64>(), 6_300_000);
        // the Seekers and the caught Hiders lost money
        assert_eq!(losers_mask(&seat_stakes(0), &p), 0b11_1111);
    }

    #[test]
    fn seekers_win_only_when_every_hider_is_caught() {
        let o = [0, 0, 0, 0, 0, 0, 1, 1];
        let p = payouts_for(&STAKES, 1_000, 1, &o).unwrap();
        assert_eq!(p[0], 6_750_000 + 6 * 2_250_000);
        assert_eq!(p[1], 6_750_000 + 2 * 2_250_000);
        assert_eq!(p.iter().sum::<u64>(), 31_500_000);
        assert_eq!(losers_mask(&seat_stakes(1), &p), 0b11_1111_1100);
    }

    #[test]
    fn payouts_never_exceed_the_net_pot() {
        for tier in 0..2u8 {
            let net_pot: u64 = seat_stakes(tier).iter().map(|s| s - fee_on(*s, 1_000)).sum();
            for code in 0..3u32.pow(8) {
                let mut o = [SURVIVED; HIDER_SEATS];
                let mut c = code;
                for x in o.iter_mut() {
                    *x = match c % 3 {
                        0 => SURVIVED,
                        1 => 0,
                        _ => 1,
                    };
                    c /= 3;
                }
                let p = payouts_for(&STAKES, 1_000, tier, &o).unwrap();
                let paid: u64 = p.iter().sum();
                assert!(paid <= net_pot);
                assert!(net_pot - paid < 8, "dust stays below one unit per survivor");
            }
        }
    }

    #[test]
    fn bad_outcomes_are_refused() {
        assert!(payouts_for(&STAKES, 1_000, 0, &[2, SURVIVED, SURVIVED, SURVIVED, SURVIVED, SURVIVED, SURVIVED, SURVIVED]).is_err());
    }

    #[test]
    fn rewards_are_never_overpaid() {
        let (mut acc, mut carry) = (0u128, 0u128);
        (acc, carry) = accrue_rewards(acc, carry, 0, 70_000).unwrap();
        assert_eq!((acc, carry), (0, 70_000 * REWARD_SCALE), "nobody staked: carried");
        let mut paid_in = 70_000u64;
        // stakers come and go between accruals; every sync floors in the program's favour
        let mut stakes = [(3u64, 0u128, 0u64), (5, 0, 0), (11, 0, 0)];
        for round in 0..300u64 {
            let total: u64 = stakes.iter().map(|s| s.0).sum();
            (acc, carry) = accrue_rewards(acc, carry, total, 70_001).unwrap();
            paid_in += 70_001;
            let i = (round % 3) as usize;
            let (staked, index, owed) = stakes[i];
            stakes[i] = (staked + round % 4, acc, owed + earned(staked, acc, index).unwrap());
        }
        let owed: u64 = stakes.iter().map(|(s, index, owed)| owed + earned(*s, acc, *index).unwrap()).sum();
        let carried = (carry / REWARD_SCALE) as u64;
        assert!(owed + carried <= paid_in);
        assert!(paid_in - owed - carried <= 3 * 300, "at most one base unit lost per sync");
    }

    #[test]
    fn auction_descends_from_one_and_a_half_times_the_last_fill_to_the_floor() {
        let a = Auction { last_price: 100 * U, started_at: 1_000, floor_price: U, duration: 600, lot: 1_000 * U, min_fill: U };
        assert_eq!(auction_price(&a, 1_000), 150 * U);
        assert_eq!(auction_price(&a, 900), 150 * U, "clock before the start: start price");
        assert_eq!(auction_price(&a, 1_300), 150 * U - (149 * U) / 2);
        assert_eq!(auction_price(&a, 1_600), U);
        assert_eq!(auction_price(&a, 99_999), U);
        let mut prev = u64::MAX;
        for t in (1_000..1_700).step_by(7) {
            let p = auction_price(&a, t);
            assert!(p <= prev && p >= a.floor_price);
            prev = p;
        }
    }

    #[test]
    fn a_fill_pays_from_both_pools_in_proportion() {
        // 100 $DS per USDC; pools 14 and 14 USDC; seller offers 1 000 $DS
        let f = auction_fill(100 * U, 1_000 * U, 14 * U, 14 * U, 1_000 * U, U).unwrap();
        assert_eq!(f.usdc, 10 * U);
        assert_eq!(f.ds, 1_000 * U);
        assert_eq!((f.from_buyback, f.from_rebate), (5 * U, 5 * U));
        assert_eq!((f.ds_burned, f.ds_to_reserve), (500 * U, 500 * U));
        // the lot caps a fill; the seller keeps what is not needed
        let f = auction_fill(100 * U, 10_000 * U, 30 * U, 10 * U, 20 * U, U).unwrap();
        assert_eq!((f.usdc, f.ds), (20 * U, 2_000 * U));
        assert_eq!((f.from_buyback, f.from_rebate), (15 * U, 5 * U));
        // rounding never takes more $DS than the price asks, nor pays more than the pools hold
        for (price, max_ds, b, r) in [(3u64, 10u64, 5u64, 0u64), (7, 1, 1, 1), (333_333, 999_999, 7, 13), (U, U, 1, 0)] {
            if let Some(f) = auction_fill(price, max_ds, b, r, u64::MAX, U) {
                assert!(f.ds <= max_ds && f.usdc <= b + r);
                assert!(f.from_buyback <= b && f.from_rebate <= r);
                assert_eq!(f.ds_burned + f.ds_to_reserve, f.ds);
                assert!(f.ds as u128 * U as u128 >= f.usdc as u128 * price as u128);
            }
        }
        assert!(auction_fill(100 * U, 1, 14 * U, 0, 1_000 * U, U).is_none(), "too little $DS for one USDC base unit");
    }

    #[test]
    fn the_buyback_waits_for_its_target_then_spends_exactly_it() {
        let t = 150 * U;
        assert_eq!(buyback_available(149 * U, t, 0), 0, "below the target: closed");
        assert_eq!(buyback_available(400 * U, t, 0), t, "a round spends exactly the target");
        assert_eq!(buyback_available(400 * U, t, 30 * U), 30 * U, "an open round spends what it has left");
        assert_eq!(buyback_available(7, 0, 0), 7, "a target rounded down to zero spends as it comes");
    }

    #[test]
    fn the_target_falls_two_percent_per_round_rounded_down() {
        let targets: Vec<u64> = (0..5).map(|n| buyback_target_after(150 * U, n)).collect();
        assert_eq!(targets, vec![150_000_000, 147_000_000, 144_060_000, 141_178_800, 138_355_224]);
        assert_eq!(next_buyback_target(138_355_224), 135_588_119);
        assert_eq!(next_buyback_target(1), 0);
        assert_eq!(buyback_target_after(1, 10), 0);
        let mut t = 150 * U;
        for _ in 0..2_000 {
            let n = next_buyback_target(t);
            assert!(n <= t);
            t = n;
        }
        assert_eq!(t, 0, "it reaches zero, and stays there");
    }

    #[test]
    fn rebates_convert_at_the_reserve_cost_and_never_beyond_it() {
        // the reserve bought 1 400 $DS for 14 USDC
        assert_eq!(rebate_claim(2 * U, 1_400 * U, 14 * U), (2 * U, 200 * U));
        assert_eq!(rebate_claim(20 * U, 1_400 * U, 14 * U), (14 * U, 1_400 * U), "only as far as the reserve reaches");
        assert_eq!(rebate_claim(5, 0, 0), (0, 0));
        // rounding keeps the rest of the reserve at least as rich per USDC
        let (u, d) = rebate_claim(3, 1_000, 7);
        assert_eq!((u, d), (3, 428));
        assert!((1_000 - d) as u128 * 7 >= 1_000u128 * (7 - u) as u128);
    }

    #[test]
    fn vesting_releases_linearly_after_the_cliff() {
        let (start, cliff, end) = (0, 100, 400);
        assert_eq!(vested(1_000, start, cliff, end, 99), 0);
        assert_eq!(vested(1_000, start, cliff, end, 100), 250);
        assert_eq!(vested(1_000, start, cliff, end, 200), 500);
        assert_eq!(vested(1_000, start, cliff, end, 400), 1_000);
        assert_eq!(vested(1_000, start, cliff, end, 9_999), 1_000);
    }
}
