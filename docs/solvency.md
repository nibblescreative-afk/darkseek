# Solvency

The vault program keeps every token it owes in two custody accounts it owns:
one for USDC, one for $DS. These invariants hold after every instruction, and
anyone can check them from public data.

## The invariants

**1. USDC custody covers everything owed.**

```
custody USDC  >=  sum of vault balances
                + sum of room pots
                + treasury + staker pool + rebate pool + buyback pool
```

The two sides are equal unless someone sent USDC to custody directly; any
surplus is unowned and stays there.

**2. Payouts come only from the stakes in that room.** A room's pot holds the
stakes of the round in play: the full stakes while the lobby fills, and the
stakes less the fee once the round starts. Settlement computes every payout
from the rules and refuses to pay more than the pot; nothing else adds to or
takes from a pot. Rounds need no outside liquidity and no house money.

```
open room:     pot == sum of the seats' stakes
live room:     pot == sum of the seats' stakes, less the fee
settled room:  pot == 0
```

**3. Locked stakes match the seats.** A vault's `locked` is the sum of the
stakes it has in open and live rooms, so over all vaults:

```
sum of vault locked == sum of seat stakes in open and live rooms
```

**4. $DS custody covers everything owed.**

```
custody $DS  >=  $DS reserve + sum of every vault's free and staked $DS
sum of vault staked $DS == config.ds_staked
```

The reserve holds only $DS the rebate pool bought; the program never mints
$DS and holds no allocation of it.

**5. Stakers can always be paid.** The staker pool covers every staker's
rewards, claimed or not:

```
staker pool >= sum over stakers of (rewards synced + rewards earned since)
```

The reward accumulator carries every remainder in scaled units, so the sum of
all rewards can never exceed what was paid in.

**6. Every rebate credit is backed.** Rebate credit is owed in USDC and paid in
$DS. The USDC behind it is either still in the rebate pool or already spent on
$DS in the reserve, at a recorded cost:

```
sum of vault rebate credits == config.rebate_credits
rebate pool + reserve cost  >= config.rebate_credits
```

A claim pays at the reserve's average cost and never more than the reserve
holds, so claims cannot overdraw it.

## Why every instruction keeps them

Every instruction moves tokens and the matching counters together, or moves
value between counters without touching tokens:

| Instruction | Tokens | Counters |
|---|---|---|
| `deposit` | custody up by x | vault balance up by x |
| `withdraw` | custody down by x | vault balance down by x |
| `lock_stake` | none | stake s from vault balance to vault locked and room pot |
| `unlock_stake` | none | stake s from room pot back to vault balance; vault locked down by s |
| `start_round` | none | the fee from room pot to the four pools, whose parts add up to the fee |
| `settle_round` | none | room pot to 0: each vault's locked down by its stake, balance up by its payout, dust to treasury; losing seats' rebate credit up by their share of the round's rebate |
| `cancel_round`, `abort_stale_round` | none | room pot to 0: each vault's locked down by its stake, balance up by its refund, remainder to treasury; after the start, every seat's rebate credit up by its share |
| `charge` | none | x from vault balance to treasury |
| `pay` | none | x from one vault balance to another |
| `sweep_treasury` | custody down by x | treasury down by x |
| `claim_rewards` | none | r from staker pool to vault balance |
| `claim_rebate` | none | credit c from vault and config credits, its cost from the reserve cost, its $DS from the reserve to the vault's free $DS |
| `sell_ds` | USDC custody down by u; the seller's $DS burned (buyback part) or moved into $DS custody (rebate part) | buyback pool down by the round's part, rebate pool down by the rest; $DS reserve up by the rebate part and reserve cost up by what it paid; the buyback target down 2% when a round's budget is spent |
| `deposit_ds`, `withdraw_ds` | $DS custody up or down by x | vault free $DS up or down by x |
| `stake_ds`, `unstake_ds` | none | x between vault free and staked $DS; config staked $DS follows |

Three layers of tests hold the program to this table, and a fourth holds each
release to the one deployed before it:

- **Every outcome.** A round has 6,561 possible outcomes: each of the eight
  Hiders survives or is caught by one of the two Seekers. The program's unit
  tests compute the payouts of all of them, for both tiers, and check that no
  round pays more than its pot and that the dust left over stays below one
  base unit per survivor. The SDK checks that its decimal rules agree with the
  program's on every one of them.
- **Every scenario.** The validator tests (`tests/protocol.test.ts`,
  `tests/timelocks.test.ts`) check invariants 1 to 6 with exact equality after
  every step of every scenario: rounds won by either side, cancelled and stale
  rounds, purchases, staking, auction fills, buyback rounds, rebate claims and
  treasury sweeps.
- **Random sequences.** `tests/invariants.test.ts` fuzzes the real program in
  LiteSVM. Each seed plays a random sequence of everything players, the game
  server, the admin and strangers can do: deposits, withdrawals, purchases and
  payments, seats taken and left, rounds started, settled with random outcomes,
  cancelled or left until anyone may unwind them, $DS deposited, staked and
  withdrawn, rewards and rebates claimed, $DS sold into the auction, treasury
  sweeps, and the clock moved. After every step the books must balance to the
  base unit, every settlement must pay each seat exactly what `payoutsFor`
  says, and a refused step must change nothing. CI runs six seeds of 160 steps
  on every change; `FUZZ_SEEDS` and `FUZZ_STEPS` run longer campaigns, and
  `FUZZ_SEED` replays the seed a failure prints.
- **Upgrade in place.** `tests/upgrade.test.ts` runs the previous release's
  program (its GitHub release asset, checked against the release's
  `SHA256SUMS`), plays rounds and leaves a lobby forming, before and after $DS
  is recorded, then puts the new build at the same address and checks that
  every account still decodes, plays on and balances to the base unit. The
  Validator workflow runs it on every change against the latest release.

## Check it yourself

For a deployment listed in [deployments.md](deployments.md), from a clone of
this repository, with Node 22:

```sh
npm ci
npm run verify -- solvency --cluster devnet --program <program id>
```

It reads the config, both custody accounts, all six rooms and every vault
(one `getProgramAccounts` call), then checks each invariant and prints the
totals. The indexer serves the same report at `GET /solvency`.

To check by hand, read the custody balances with the Solana CLI and every vault
with one RPC call (vaults are the program's 137 byte accounts):

```sh
spl-token balance --address <config.custody> --url devnet
spl-token balance --address <config.ds_custody> --url devnet
curl -s https://api.devnet.solana.com -H 'content-type: application/json' -d '{
  "jsonrpc": "2.0", "id": 1, "method": "getProgramAccounts",
  "params": ["<program id>", {"encoding": "base64", "filters": [{"dataSize": 137}]}]
}'
```

The layouts of every account are in `packages/sdk/src/layouts.ts` and in the IDL
(`programs/darkseek-vault/idl/darkseek_vault.json`).

## What solvency does not mean

Solvency means the program can pay every balance it records. It does not
protect against a wrong outcome reported by the game server (see
[security-model.md](security-model.md)), against the USDC issuer freezing the
custody account, or against a malicious program upgrade (see the upgrade plan
in the same document).
