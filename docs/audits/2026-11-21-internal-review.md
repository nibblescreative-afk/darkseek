# Internal review of release v0.3.0

November 2026. This is an internal review made within the project, of the
program in `programs/darkseek-vault` at release v0.3.0 (program hash
`b6bf1f5ddc29fee71db96e8bccd72054ec679ab97749176235ccee545f5a0093`, deployed on
devnet and testnet). **It is not an external audit**; the external audit comes
before mainnet ([deployments.md](../deployments.md#what-comes-before-real-money)).

## Scope and method

- Every source file of the program read against
  [security-model.md](../security-model.md), [solvency.md](../solvency.md),
  [WHITEPAPER.md](../WHITEPAPER.md) and [fairness.md](../fairness.md), the
  SDK's builders and verifier, and the tests.
- The Anchor 1.2.2 behaviour the program relies on checked in the crate's own
  source: account type and owner checks, write back on exit, rejection of
  duplicate mutable accounts.
- Arithmetic recomputed independently: all 6,561 outcomes of a round for each
  tier, the fee rounding, the rebate reserve, the reward accumulator and the
  auction.
- The release bytes tested as deployed: the program unit tests (12), the
  program on a local validator and in LiteSVM (43 tests), and stateful fuzzing
  of 40 seeds of 600 random instructions each, the books checked to the base
  unit after every step (`FUZZ_SEEDS=40 FUZZ_STEPS=600`). All passed.

## Summary

No player, outsider or game server can take funds beyond what the security
model concedes, and the escrow and payout arithmetic balances to the base unit
with every rounding in custody's favour. The findings are in the privileged
roles and at the edges of the round life; none can take a player's free
balance.

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | Medium | Before `init_ds`, the admin can reach the staker, rebate and buyback pools | fixed in v0.4.0 (not yet deployed) |
| 2 | Medium | The game server key can switch rooms off for good | fixed in v0.4.0 (not yet deployed) |
| 3 | Low | A dishonest game server can hold a lobby's stakes | fixed in v0.4.0 (not yet deployed) |
| 4 | Low | Back to back auction fills can overpay after a price drop | reduced in v0.4.0 (not yet deployed) |
| 5 | Low | The stakers' carry goes to whoever is staked at the next start | fixed in v0.4.0 (not yet deployed) |
| 6 | Low | The session's daily cap is per UTC day | documented |
| 7 | Info | That the house never plays cannot be enforced onchain | documented |
| 8 | Info | Unlocks do not give back the daily cap | noted |
| 9 | Info | The config account is written by permissionless instructions | noted |
| 10 | Info | Vesting ids can be taken first; freeze authorities are not checked | noted |
| 11 | Info | A rebate credit can be taken as USDC when no buyback round is open | noted |

## Findings

### 1. Before `init_ds`, the admin can reach the pools (medium)

`start_round` fills the staker, rebate and buyback pools whether or not a $DS
mint is recorded, and `init_ds` lets the admin record any fixed supply mint
with six decimals and auction settings that are barely bounded. An admin that
records a token of its own with a floor of one, a one second duration and a
target of one base unit can sell that token into the auction until both pools
are empty, then stake it to collect the stakers' share of every later round.
Even with the real $DS, a wrong floor or duration lets any holder empty the
pools at an absurd price. `npm run verify -- config` checks none of the
auction settings. On devnet no $DS is recorded; on testnet a test token is
recorded whose whole supply sits in the owner's wallet.

Planned for v0.4.0: no accrual into the three pools until $DS is recorded;
bounds on the auction settings onchain (floor against genesis price, a minimum
duration, caps on the lot and the target), checked by the verifier too.

### 2. The game server key can switch rooms off for good (medium)

`lock_stake` on a settled room accepts any round number above the last one,
and nothing lowers a room's round or recreates a room. A key that locks round
`u64::MAX`, unlocks and cancels leaves that room with no next round. No funds
are lost; recovery takes a program upgrade, and would be impossible once the
upgrade authority is given up.

Planned for v0.4.0: only the next round number (or a small bounded skip).

### 3. A dishonest game server can hold a lobby's stakes (low)

Only the game server can unlock a seat before the round starts, and every lock
or unlock refreshes the room's clock, so a server that keeps locking and
unlocking another seat keeps `abort_stale_round` from ever applying.

Planned for v0.4.0: a seat's owner can leave an open room on their own after a
timeout, or each seat times out on its own.

### 4. Back to back auction fills (low)

Each fill restarts the auction price at 1.5 times the fill's price, and
several fills can land in one transaction. After a sharp fall in the price of
$DS (or over pools that built up before $DS existed), consecutive fills pay
far above the market.

Planned for v0.4.0: a minimum time between fills, or a cap on what a window
can spend.

### 5. The stakers' carry (low)

While nobody stakes $DS, the stakers' share waits in `reward_carry` and goes in
full to whoever is staked at the next round's start, with no lock up.

Planned for v0.4.0: release the carry over time, or only to stake held for a
full round.

### 6. The daily cap is per UTC day (low)

The session's cap resets at 00:00 UTC, so twice the cap can be locked within
seconds around midnight. Documented in the security model; a rolling window is
a possible change.

### 7 to 11 (info)

- The program checks that ten distinct vaults with sessions are seated; it
  cannot tell whose wallets they are. That the game never seats its own is a
  promise of the game ([fairness.md](../fairness.md)), checked through the
  public history of every wallet.
- Unlocks and refunds do not give back the daily cap, so lobby churn uses it up.
- `claim_rewards`, `claim_rebate`, `sell_ds`, `charge` and the staking
  instructions write the one config account, so spam with priority fees can
  delay the game server's transactions.
- Anyone can create the vesting for a given mint, beneficiary and id first; a
  mint with a freeze authority can stall vesting claims (it cannot take them).
- A holder with enough rebate credit can sell $DS on the rebate side and then
  claim the reserve, taking USDC instead of $DS; nobody else loses.

## Checked and found sound

- Paying the right vaults: settle, cancel and abort check each vault's owning
  program, its type, that it is writable and that it belongs to the seat's
  owner; a wrong order, an outsider, a duplicate or a missing vault fails.
- No double lock and no stranded stake: every exit path subtracts exactly that
  seat's stake from `locked`.
- Round life: start needs an open, full room and the right round; settle needs
  a live room and the right round; no double settle; no live round with an
  empty seat.
- Sessions: strict expiry; the cap and the balance are checked before spending;
  only the owner sets a session.
- Payouts: never above the pot over all 6,561 outcomes of each tier; leftover
  dust (at most 2 base units casual, 3 pro) goes to the treasury; the four fee
  parts add up to the fee; overflow checks are on in the release profile.
- Rebates, staking rewards and the auction arithmetic: every remainder is
  carried, no claim exceeds its pool, the price never drops below the floor.
- Tokens: USDC pinned to SPL Token with its mint and custody fixed in config;
  the $DS mint, custody and token program pinned; the Token 2022 extension
  allowlist excludes fees, hooks, permanent delegates, pausing and close
  authority.
- Signers and addresses: vault spends need the owner's signature; server and
  admin actions are checked against `config.authority` and `config.admin`;
  `initialize` needs the upgrade authority; `accept_admin` needs the proposed
  key to sign; stored bumps; seeds that cannot collide.
- No close, realloc, `init_if_needed` or call into an untrusted program.

## Open questions for the external audit

- A vault for the all zero key can be opened by anyone, and empty seats are
  marked by that key. A session for it would need a signature for the zero key,
  which strict ed25519 verification rejects; v0.4.0 should refuse that owner in
  `open_vault` and `lock_stake` regardless.
- Vaults can never be closed, so a game server that opens vaults on request
  spends rent it never gets back (the game limits new vaults per network and
  per hour).
- Whether the planned multisig's timelock also covers the admin instructions
  (`set_authority`, `init_ds`, `sweep_treasury`), not only upgrades: the program
  has no delay of its own.

## What v0.4.0 does about it

- **1.** Until `init_ds` records $DS, `start_round` gives the whole fee to the
  treasury (`fee_parts`), so the staker, rebate and buyback pools stay empty and
  no choice of mint can take anything that waited. `init_ds` refuses settings
  outside bounds (`ds_args_ok`): a floor under a thousandth of the genesis price,
  a descent under an hour or over seven days, a lot over 100,000 USDC, a first
  target over 1,000,000 USDC. `npm run verify -- config` checks the same bounds,
  and warns when a deployment from before v0.4.0 holds fees in those pools.
- **2.** `lock_stake` accepts only the next round number: a settled room moves
  to round + 1, and an open room nobody sits in to round + 1, never further.
- **3.** `leave_seat`: the seat's owner signs and takes the whole stake back from
  an open lobby once it has been forming for 30 minutes. The clock is
  `Room.started_at`, set when the first seat is taken in an empty room; locks
  and unlocks of other seats do not restart it. To seat a player again in a
  fresh lobby, the game server has to give the stake back and lock it anew
  under the player's session (against its daily cap), so a player who has
  revoked the session can leave once the lobby has been forming for 30
  minutes, whatever the server does.
- **4.** A fill within ten minutes of the one before records twice its price as
  the auction's reference (`next_reference_price`), so the next descent starts
  at 3 times that fill instead of 1.5. After a tenfold fall in the price of $DS,
  three fills reach the market instead of six, and the pools pay roughly 40%
  less above it. Without a price oracle this reduces the loss; it does not
  remove it. The rule only ever makes the auction ask more $DS for each USDC,
  so a seller who fills twice on purpose slows the buyback down at their own
  cost; it cannot make the pools pay more.
- **5.** `accrue_rewards` pays out this round's share and at most a tenth of what
  waited (at least one unit while anything waits).
- Needs confirmation 1: `open_vault` and `lock_stake` refuse the all zero key.

No account changes its layout: a deployment upgrades in place and every config,
room and vault stays readable. Error codes keep their numbers (`TooEarly` is
added at the end); `SeatLeft` is a new event.

