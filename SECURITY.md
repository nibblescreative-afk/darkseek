# Security policy

The vault program holds players' money, so we take every report seriously and
answer quickly.

## Reporting a vulnerability

Report privately through GitHub:
[Security, Report a vulnerability](https://github.com/nibblescreative-afk/darkseek/security/advisories/new).
Please do not open a public issue or post on social media, and never test
against other people's funds.

Include what you found, how to reproduce it (a failing test against the local
validator is ideal: see `tests/protocol.test.ts`), and what you think the
impact is.

## What happens next

| When | What |
|---|---|
| within 48 hours | we confirm we received it |
| within 7 days | we tell you whether we reproduced it and how severe we think it is |
| fix | a release through the normal process ([docs/releasing.md](docs/releasing.md)); for a live risk we may act sooner, within what the multisig and its timelock allow |
| disclosure | we publish an advisory once the fix is deployed, crediting you unless you prefer otherwise |

## Scope

In scope: everything in this repository, above all `programs/darkseek-vault`,
and any deployment listed in [docs/deployments.md](docs/deployments.md).

Also in scope, through the same channel: the game client, the game server and
the website at [thedarkseek.xyz](https://thedarkseek.xyz/security). Their code
is not in this repository, so we handle those reports directly.

Out of scope: third party programs (SPL Token, Token 2022, Squads), floods and
other denial of service tests, and findings that need a compromised admin or
upgrade key. What those keys can do is documented in
[docs/security-model.md](docs/security-model.md); a way for them to do more
than that document says is in scope.

## Rewards

Nothing is deployed yet and there is no bug bounty. Valid reports are credited
publicly in the advisory, unless you prefer otherwise.

## Safe harbor

We will not take legal action against research done in good faith under this
policy: testing on a local validator or devnet, not accessing other people's
data or funds, and giving us reasonable time to fix before disclosure.
