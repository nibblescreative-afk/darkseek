# Deployments

**There is no official deployment yet.** The owner will deploy the program with
their own wallet, devnet first, and list here, for each cluster:

- the program id;
- the upgrade authority and the admin (the multisig, for anything with real money);
- the game server key;
- the stake token mint;
- the release tag and the hash of its verifiable build.

The game runs at [thedarkseek.xyz](https://thedarkseek.xyz), with play money
until launch.

## $DS at launch

$DS is created on pump.fun. At launch this page lists:

| | |
|---|---|
| $DS mint | the contract address, also shown on the site |
| Token program | SPL Token or Token 2022, as pump.fun created it |
| Launch buy wallet | the team's wallet that bought 3% of the supply on the bonding curve |
| Launch buy transaction | its signature |
| Launch buy in USDC | what the buy cost, converted to USDC, with the price source and time used |
| First buyback target | half of that, as recorded by `init_ds` |
| Auction | genesis price (the $DS the launch buy got per USDC), floor, duration, lot, minimum fill |
| Team lock | if the team locks any of its tokens: the lock account, cliff and end |

`npm run verify -- config --program <id> --ds-mint <mint> --launch-buy-usdc <units>`
checks the recorded target against the launch buy and every later target
against the 98% rule.

Until then, no program, token, site or wallet can claim to be the DarkSeek
deployment. Check any address against this page before you sign anything.

## Placeholders in the code

The ids in the source are devnet demo placeholders. They are not deployed, and
nothing should be sent to them:

| | Placeholder | Where |
|---|---|---|
| Program id | `4jNw2nbMz3ZHAH3dWcUrUbS78mfKPNqF1Bbq1x1vVJQt` | `declare_id!` in the program, `PROGRAM_ID` and `DEMO_DEFAULTS` in the SDK |
| Test USDC | `87afD6thNbzSWfACfW5z4kmVL9jrnafGQAJQCj9iciz` | `DEMO_DEFAULTS` in the SDK |

The tests deploy the program at the placeholder id on their own local
validator. A real deployment sets its own program id in `declare_id!`, the SDK's
`DEPLOYMENTS` and this page, in the same release.

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

1. a devnet deployment from a tagged release, listed here;
2. an external audit of the program, published in this repository;
3. the upgrade authority and the admin held by a Squads multisig (3 of 5, 48
   hour timelock), listed here;
4. $DS launched on pump.fun and the launch details above listed here.

`scripts/test-ds-mint.ts` makes a token shaped like a pump.fun mint for local
and devnet tests only; it never creates $DS.
