# Deployments

| Cluster | Status |
|---|---|
| Testnet | deployed from release v0.3.0 on 2026-11-21, upgraded in place to release v0.4.1 on 2026-11-22, and verified: the program onchain is the release build; the game runs here |
| Devnet | deployed from release v0.3.0 on 2026-11-21 and verified: the program onchain is the release build; its upgrade to v0.4.1 is still to come |
| Mainnet | not deployed: an external audit and the multisig come first |

Each deployment lists the program id, the upgrade authority and the admin (the
multisig, for anything with real money), the game server key, the stake token
mint, and the release tag with the hash of its verifiable build.

Release v0.4.0 was published without its build files. Release v0.4.1 is the
same code with them: deploy and verify v0.4.1.

## Testnet

Test money only: the stake token has no value and the game hands it out. The
program id, every account derived from it and the test USDC mint have the same
addresses as on devnet.

| | |
|---|---|
| Program id | `DarkHJqM8GMmCu7BWko6HMG4YgJgZ7jeEr2Qe967e5sE` |
| Release | [v0.4.1](https://github.com/nibblescreative-afk/darkseek/releases/tag/v0.4.1), since 2026-11-22 (before it, [v0.3.0](https://github.com/nibblescreative-afk/darkseek/releases/tag/v0.3.0)) |
| Program hash (solana-verify) | `78d2865f6040e33963849383cb21fa7a5965e1835085d4613b31fef1c0c073be` |
| Deployed | 2026-11-21 18:57 UTC, slot 467367254, from v0.3.0; upgraded in place to v0.4.1 on 2026-11-22 11:00 UTC, slot 467635301, signed by the upgrade authority (transaction `5PvgFvca…6KyQrk`), after the program account was extended by 14,672 bytes for the longer build |
| Upgrade authority | `D2tY97BpGjsGG9qjrcJERP6NnknV48PeQ2jevLptFdyn`, the owner's wallet |
| Admin | `D2tY97BpGjsGG9qjrcJERP6NnknV48PeQ2jevLptFdyn`, the owner's wallet, since 2026-11-21 19:15 UTC: it signed `accept_admin` itself (transaction `UFd8zr2Y…dQEEYs` in the [config account's history](https://solscan.io/account/CSCcsHkyaANpznMQNXwgPLxigeCnQQLWRPMiV2hAtpsd?cluster=testnet)) |
| Stake token (test USDC, six decimals) | `34EifEmt9oXcyPNzCWEFjpp9nieq1XvgZKLKRuv1VZhj`; the game server key may mint it, nobody can freeze it |
| Test $DS (test only, it is not $DS) | `6SrLNa3d3gZJaWNyLvhWvqCSbvfZYSgw3LDQ1WW3PbSw`, made by `scripts/test-ds-mint.ts` like a pump.fun mint: SPL Token, one billion with six decimals, no mint or freeze authority; the whole supply is in the owner's wallet |
| Game server key | `6VWtA4U4BjwNyviWJB8KxU6n4D2vykbd53MmimyNmVsq` |
| Config account | `CSCcsHkyaANpznMQNXwgPLxigeCnQQLWRPMiV2hAtpsd` |

`init_ds` recorded the test token with test values, as if a launch buy had
bought 3% of the supply (30,000,000 tokens) for 100 test USDC:

| | |
|---|---|
| First buyback target | 50 test USDC, half the assumed launch buy |
| Genesis price | 300,000 tokens per USDC (`300000000000` base units) |
| Floor price | 300 tokens per USDC, a thousandth of the genesis price: an emergency bound only, since the price follows the fills |
| Auction | legs of 6 hours: after each fill the price restarts at 1.5 times the fill's (3 times after a fill within ten minutes) and halves leg by leg, so past the last fill the bid at most doubles every leg; at most 1,000 USDC and at least 1 USDC per fill |

Check it yourself, from a clone of this repository:

```sh
npm ci
scripts/verify-release.sh v0.4.1 --cluster testnet                  # the program onchain is the release build
npm run verify -- all --cluster testnet --launch-buy-usdc 100000000  # settings, the test $DS, solvency, roles
```

The game at [thedarkseek.xyz](https://thedarkseek.xyz) runs its staked rounds,
shop and P2P payments through this deployment, in test USDC, since
2026-11-21 19:08 UTC.

## Devnet

Test money only: the stake token has no value and the game hands it out.

| | |
|---|---|
| Program id | `DarkHJqM8GMmCu7BWko6HMG4YgJgZ7jeEr2Qe967e5sE` |
| Release | [v0.3.0](https://github.com/nibblescreative-afk/darkseek/releases/tag/v0.3.0) |
| Program hash (solana-verify) | `b6bf1f5ddc29fee71db96e8bccd72054ec679ab97749176235ccee545f5a0093` |
| Deployed | 2026-11-21 08:26 UTC, slot 524651892 |
| Upgrade authority | `D2tY97BpGjsGG9qjrcJERP6NnknV48PeQ2jevLptFdyn`, the owner's wallet |
| Admin | `D2tY97BpGjsGG9qjrcJERP6NnknV48PeQ2jevLptFdyn`, the owner's wallet, since 2026-11-21 08:39 UTC: it signed `accept_admin` itself (transaction `51s91RBR…BbnXXZ` in the [config account's history](https://solscan.io/account/CSCcsHkyaANpznMQNXwgPLxigeCnQQLWRPMiV2hAtpsd?cluster=devnet)) |
| Stake token (test USDC, six decimals) | `34EifEmt9oXcyPNzCWEFjpp9nieq1XvgZKLKRuv1VZhj`; the game server key may mint it, nobody can freeze it |
| Game server key | `6VWtA4U4BjwNyviWJB8KxU6n4D2vykbd53MmimyNmVsq` |
| Config account | `CSCcsHkyaANpznMQNXwgPLxigeCnQQLWRPMiV2hAtpsd` |

Check it yourself, from a clone of this repository:

```sh
npm ci
scripts/verify-release.sh v0.3.0 --cluster devnet   # the program onchain is the release build
npm run verify -- all --cluster devnet              # settings, solvency, roles
```

The game at [thedarkseek.xyz](https://thedarkseek.xyz) ran its staked rounds,
shop and P2P payments through this deployment, in test USDC, until
2026-11-21 19:08 UTC, when it moved to testnet. The deployment stays up, and
the checks above still pass.

## $DS at launch

$DS is created on pump.fun. At launch this page lists:

| | |
|---|---|
| $DS mint | the contract address, also shown on the site |
| Token program | Token 2022, as pump.fun creates every coin now (`CreateV2`); the program also accepts SPL Token |
| Mode | normal: a coin in pump.fun's Mayhem mode has two billion tokens, and `init_ds` refuses it |
| Launch buy wallet | the team's wallet that bought 3% of the supply on the bonding curve |
| Launch buy transaction | its signature |
| Launch buy in USDC | what the buy cost, converted to USDC, with the price source and time used |
| First buyback target | half of that, as recorded by `init_ds` |
| Auction | genesis price (the $DS the launch buy got per USDC), floor (one base unit: no fixed limit), leg duration, lot, minimum fill |
| Team lock | if the team locks any of its tokens: the lock account, cliff and end |

`npm run verify -- config --program <id> --ds-mint <mint> --launch-buy-usdc <units>`
checks the recorded target against the launch buy and every later target
against the 98% rule.

Until then, no program, token, site or wallet can claim to be the DarkSeek
deployment. Check any address against this page before you sign anything.

## The program id in the code

`declare_id!` in the program, `PROGRAM_ID` and `DEPLOYMENTS` in the SDK carry
the program id above, the same on devnet and testnet. The tests deploy the
program at that id on their own local validator, which is separate from both.

## Accounts of a deployment

Every account the program owns is an address derived from the program id:

| Account | Seeds |
|---|---|
| Config | `"config"` |
| USDC custody | `"custody"` |
| $DS custody | `"ds_custody"` |
| Vault of a wallet | `"vault"`, wallet |
| Room 1 to 6 | `"room"`, room number as one byte |
| Vesting schedule | `"vesting"`, mint, beneficiary, id as 8 bytes little endian |
| Vesting tokens | `"vesting_tokens"`, vesting schedule |

Once a deployment is listed, `npm run verify -- all --program <id>` checks all
of them ([verify.md](verify.md)).

## What comes before real money

1. devnet and testnet deployments from a tagged release, listed here;
2. an external audit of the program, published in this repository;
3. the upgrade authority and the admin held by a Squads multisig (3 of 5, 48
   hour timelock), listed here;
4. $DS launched on pump.fun in normal mode and the launch details above
   listed here;
5. the stake token is Circle's USDC, `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
   (SPL Token, six decimals); on mainnet `npm run verify -- config` compares the
   recorded mint with it.

`scripts/test-ds-mint.ts` makes a token shaped like a pump.fun mint for local
and devnet tests only; it never creates $DS.
