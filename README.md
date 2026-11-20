# DarkSeek protocol

[![CI](https://github.com/nibblescreative-afk/darkseek/actions/workflows/ci.yml/badge.svg)](https://github.com/nibblescreative-afk/darkseek/actions/workflows/ci.yml)
[![License: BUSL 1.1](https://img.shields.io/badge/license-BUSL--1.1-blue)](LICENSE)

DarkSeek is a hide and seek game played for stakes: eight Hiders and two
Seekers in a pitch black cave, a 10 second head start, then a 2:00 hunt. Every
staked seat is a real player, and the only money in a round is what its ten
players put in. The game runs at [thedarkseek.xyz](https://thedarkseek.xyz)
(play money until launch).

This repository is the part of DarkSeek that touches money: the Solana program
that holds every stake and pays every round, the SDK and tools to check it,
the indexer that follows it, and the documents that say how the economy works.
If you play, review the economy or audit the code, everything you need to
check that there is no hidden code that harms players is here.

## What is here

```
programs/darkseek-vault   the onchain program (Anchor): vaults, rooms, settlement, fee split,
                          rebates, $DS staking, the buyback rule and auction, token locks
packages/sdk              TypeScript SDK and the darkseek-verify command
apps/indexer              follows the program, stores its events, serves /stats and /solvency
tests                     the program on a local validator and in LiteSVM
scripts                   build, IDL, cluster setup, a test only pump.fun shaped mint, release checks
tools/idl-build           builds the IDL without the Anchor CLI
docs                      white paper, security model, solvency, fairness, verification
```

Start with the [white paper](docs/WHITEPAPER.md). Then:

- [security-model.md](docs/security-model.md): every power the game server and
  the admin have, and what they cannot do
- [solvency.md](docs/solvency.md): the invariants that keep every balance
  covered, and how to check them
- [fairness.md](docs/fairness.md): why the character you pay for does not
  decide the round, and why the house never plays
- [verify.md](docs/verify.md): bytecode, releases, settings, $DS and NFT
  checks, the website build
- [deployments.md](docs/deployments.md): the addresses we vouch for

## What is not here

The game itself stays private: the engine, the game server, the art, the
characters' animation and the website. A game anyone could clone would be
copied into look alike sites that take players' money, so we publish the part
that must be trusted and keep the part that must be played. None of the
guarantees about money depend on the private code: the program enforces them
whatever the game server does, and [security-model.md](docs/security-model.md)
lists exactly what the game server is trusted for (reporting who caught whom)
and how that trust is bounded. Each release publishes a hash of the website
build so you can check the site serves the released build.

## Check it

Nothing is deployed yet ([deployments.md](docs/deployments.md) will list the
official deployment). Once a deployment is listed, one command checks it from
any public RPC:

```sh
npm ci
npm run verify -- all --cluster devnet --program <program id> --usdc-mint <mint> --ds-mint <mint>
```

It checks the settings against the white paper, the $DS mint, solvency
(custody covers every balance owed) and the program hash. Details in
[verify.md](docs/verify.md). The same checks run in the tests against a local
validator.

## Build and test

Requirements: Rust (stable), the Agave CLI 4.4.1 (`cargo build-sbf`,
`solana-test-validator`) and Node 22.13 or later. The Anchor CLI is not needed.

```sh
npm ci
scripts/build-program.sh        # target/deploy/darkseek_vault.so
npm test                        # SDK unit tests
npm run test:program            # Rust unit tests, then the program on a local validator and in LiteSVM
npm run test:indexer            # the indexer against a local validator
scripts/build-idl.sh            # programs/darkseek-vault/idl/darkseek_vault.json
```

The validator tests start their own `solana-test-validator` on ports 28899 and
up, deploy the program as upgradeable and run every scenario, checking after
each step that custody equals what the program owes, to the base unit.

## Status

Version 0.2.1, not deployed yet: devnet first, then mainnet after an external
audit and with the multisig upgrade authority described in the
[security model](docs/security-model.md). The code has not been audited.

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

[Business Source License 1.1](LICENSE). You may use this code for auditing,
verification, research and non commercial use. On 2030-11-20 it becomes
available under GPL 2.0 or later.
