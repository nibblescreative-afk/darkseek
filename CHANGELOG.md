# Changelog

## 0.3.0 (2026-11-20)

- Devnet: the program's own id, `DarkHJqM8GMmCu7BWko6HMG4YgJgZ7jeEr2Qe967e5sE`,
  in `declare_id!`, the IDL and the SDK, replacing the demo placeholder. This
  release is the one deployed to devnet, with a test stake token
  (`34EifEmt9oXcyPNzCWEFjpp9nieq1XvgZKLKRuv1VZhj`) and the addresses listed in
  docs/deployments.md. Test money only.
- SDK: `DEPLOYMENTS.devnet` is that deployment. `DEMO_DEFAULTS` is gone; the
  verify CLI checks the cluster's official deployment and asks for
  `--program` on a cluster that has none.
- Tests: stateful fuzzing of the program in LiteSVM
  (`tests/invariants.test.ts`). Seeded random sequences of every instruction,
  with the books checked to the base unit after every step, every settlement
  checked against the published payout rules, and every refused step checked
  to change nothing. It runs in the Validator workflow.
- Docs: VISION.md, why DarkSeek exists and where it is going; solvency.md
  describes the three layers of tests.
- The README presents DarkSeek as what it is, a Web3 hide and seek game, with
  this repository as its open onchain part, and shows the game. The issue
  templates take game bugs too. The program's crate description, and with it
  the IDL metadata, reads "DarkSeek vault program". No code changes.
- Repository: labels as code (`.github/labels.json`, applied by the Labels
  workflow), a dependency review check on every pull request, and grouped
  Dependabot updates. Major versions of @solana/web3.js, @noble/hashes and
  @types/node are planned by hand.
- Dependencies: `jayson` 5 under `@solana/web3.js` (an npm override). It no
  longer pulls in `uuid` 8 and `stream-json` 1, which closes four moderate
  advisories; the SDK, indexer and validator tests pass unchanged.
- The README has the roadmap, with links to the project board, the
  milestones and the pinned Roadmap issue. The issue chooser no longer lists
  the vulnerability report twice (GitHub adds its own private report link).
- ACCESSIBILITY.md: what works, the known limits of a game played in the
  dark, and how to report a barrier.
- Program: `solana-security-txt` 1.1.3 (was 1.1.1). The embedded security
  contact is unchanged, but the program binary changes, so the next release
  has a new program hash.

## 0.2.1

- Release workflow: the IDL check and the tests run before the verifiable
  build. The build container runs as root and left `target/` unwritable for
  the steps after it, so the v0.2.0 release job stopped at the IDL check and
  published nothing. Ownership of `target/` is handed back after the build.
  The program, SDK and indexer are unchanged from 0.2.0.

## 0.2.0

The first public version of the protocol. Compared with the version the game
was built against, rounds are people only, and the fee split, rebates,
staking and the buyback are onchain. Not deployed yet.

### Program

- A round starts only when all ten seats are staked by players (`RoomNotFull`
  otherwise). House stakes for bot seats are gone, with `fund_treasury` and the
  room's `house` field.
- The fee is split onchain when a round starts, by fixed basis points of the
  fee that add up to 10 000: 10% to stakers, 20% to the loser rebate, 20% to
  buyback and burn, 50% to the treasury (1%, 2%, 2% and 5% of every stake).
- Rebates: players who end a round below their stake share its rebate as USDC
  credit; a round cancelled after its start credits every seat. The rebate pool
  buys $DS continuously in the auction, and `claim_rebate` pays credit in $DS at
  the reserve's average purchase cost.
- `$DS` staking: `deposit_ds`, `stake_ds`, `unstake_ds`, `claim_rewards`,
  `withdraw_ds`. `pay_reward` is removed.
- Buyback: `init_ds` records the $DS mint (SPL Token or Token 2022, fixed
  supply, no extension but metadata), its token program and the first buyback
  target, once. A buyback round opens when the pool holds the whole target and
  spends exactly it in `sell_ds`, burning what it buys; the next target is 98%
  of the last. Nothing can raise or reset the target.
- `sell_ds`: the descending price auction for both pools, through the token
  interface so $DS may live on either token program.
- `charge` and `pay` need the vault owner's signature. The session's daily cap
  now limits room stakes.
- `initialize` needs the program's upgrade authority. The admin moves with
  `propose_admin` and `accept_admin`.
- `cancel_round` also ends an open lobby (full refunds); `abort_stale_round`
  also unwinds a lobby untouched for two hours.
- `create_vesting`, `claim_vesting`: a lock any holder may use, for either
  token program, that nobody can revoke.
- Events for every movement of value; `security.txt`.

### $DS

- Launched on pump.fun: one billion tokens, no mint or freeze authority, no
  presale and no allocations. The team's wallet buys 3% on the bonding curve at
  launch; its address and transaction, and the first buyback target derived from
  it, go into docs/deployments.md.
- `scripts/test-ds-mint.ts` makes a token of the same shape for tests only.

### What the game server has to change

- Decode the new account layouts (use `@darkseek/sdk`); error codes changed,
  match them by name (`vaultErrorOf`).
- `settle_round` takes all ten seated vaults, in slot order.
- Room stakes count toward the session's daily cap: let players choose a cap
  that covers their play (the default of 100 USDC a day is 13 pro Seeker seats).
- Prepare `charge` and `pay` as transactions the player signs (as for
  `deposit` and `withdraw`); the server can still pay the network fee.
- Staking moves onchain: replace the server's staking ledger and its
  `pay_reward` calls with `stake_ds`, `unstake_ds` and `claim_rewards`.
- Rebates are credited onchain in USDC (`RoundSettled.rebateUsdc`, the vault's
  `rebateCredit`); send `claim_rebate` for players (anyone may) and offer
  `withdraw_ds`. Stop computing $DS compensation in the game.
- Pass the $DS token program (`config.dsTokenProgram`) to every $DS
  instruction.
- After a restart, `cancel_round` returns a whole open lobby in one call.
- A lobby with no lock or unlock for two hours can be unwound by anyone: treat
  a `RoundRefunded` event for a lobby as everyone leaving.
- Setup: `scripts/setup-cluster.ts` replaces `chain/scripts/setup.ts`; the
  house treasury needs no funding.
- The program id in the source is a devnet demo placeholder. The first
  deployment sets its own id and keys and lists them in docs/deployments.md.
- Show the new split: of the 10% fee, 10% to stakers, 20% rebate, 20% buyback
  and burn, 50% treasury (the game's tokenomics used 1/2/2/95).
