# Contributing

Thanks for looking. Reviews, questions about the rules and reports of anything
that does not match the docs are as welcome as code.

## Before you start

- **Security issues** go through [SECURITY.md](SECURITY.md), never a public issue.
- **Changes to the money rules** (fees, payouts, the auction, staking) change
  what players were promised. Open an issue first so the change can be
  discussed before anyone writes code.
- The game's engine and server are not in this repository, but game bugs are
  welcome here: pick "The game" in the bug report form.

## Setup

You need Rust (stable), the Agave CLI 4.4.1 and Node 22.13 or later.

```sh
sh -c "$(curl -sSfL https://release.anza.xyz/v4.4.1/install)"
npm ci
scripts/build-program.sh
npm test && npm run test:program && npm run test:indexer
```

The validator tests start their own `solana-test-validator`; nothing touches
devnet or mainnet.

## What a change needs

| If you change | Also |
|---|---|
| the program | tests on the local validator that show the books still balance (`World.assertBooks`); rebuild the IDL (`scripts/build-idl.sh`); update the SDK layouts and builders (the IDL test tells you where) |
| what anyone can do with the program | [docs/security-model.md](docs/security-model.md), and the lists in `tests/source.test.ts` |
| an invariant | [docs/solvency.md](docs/solvency.md) and `solvencyFrom` in the SDK |
| a number players see | [docs/WHITEPAPER.md](docs/WHITEPAPER.md), `PUBLISHED` in the SDK, and the game server (tell us in the PR) |

## How changes land

`main` is protected by a ruleset. A pull request is squashed into one commit,
and it can merge only when CI, the validator tests and CodeQL pass and every
review conversation is resolved. Force pushes and deleting `main` are
blocked, and published releases are immutable, so a release's tag and files
never change after the fact.

## Style

- Rust: `cargo fmt`, `cargo clippy` clean. Checked arithmetic for anything that
  holds money. A comment says why, not what.
- TypeScript: strict mode, no `any` where a type is known, `npm run typecheck` clean.
- Docs: short sentences, plain words, numbers that match the code. No em or en
  dashes; write "onchain" and "people only".
- Commits: one logical change each, a subject line under 72 characters that
  says what changed, and a body that says why.

## Never commit

Keypairs, seed phrases, `.env` files, RPC keys or anything else secret.
`scripts/scan-secrets.sh` runs in CI and fails on them; run it before you push.

## License

By contributing you agree that your contribution is licensed under the
[Business Source License 1.1](LICENSE) of this repository, including its
change to GPL 2.0 or later on the Change Date.
