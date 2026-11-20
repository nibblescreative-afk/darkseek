# Verify everything

What you can check without trusting anyone at DarkSeek, and how. You need Node
22 and this repository; the program checks also use Docker and
[solana-verify](https://github.com/Ellipsis-Labs/solana-verifiable-build).

There is no official deployment yet. When there is one,
[deployments.md](deployments.md) lists its program id, mints, upgrade
authority and release; the commands below take those as arguments. Without
`--program`, the tools fall back to the devnet demo placeholder ids in the
source and say so; those are not a deployment.

```sh
git clone https://github.com/nibblescreative-afk/darkseek && cd darkseek
npm ci
npm run verify -- all --cluster devnet --program <program id> --usdc-mint <mint> --ds-mint <mint>
```

`npm run verify` runs the SDK's `darkseek-verify` command. Every release also
attaches the SDK as a tarball, so the same command runs without cloning:
`npx -p ./darkseek-sdk-<version>.tgz darkseek-verify all --program <program id> ...`.

## 1. The program onchain is this source

Releases are built with a verifiable build: the program is compiled inside a
pinned Docker image, so anyone who builds the same commit gets the same bytes.

Compare a deployed program with a tagged commit, from scratch:

```sh
solana-verify verify-from-repo --url https://api.devnet.solana.com \
  --program-id <program id> \
  --library-name darkseek_vault \
  --base-image solanafoundation/solana-verifiable-build:4.3.0@sha256:12fd4c0a0790f0fc41ef74b0cdb6bccc167ba6137eb1adb749bac649481c86bd \
  --commit-hash <the release tag's commit> \
  https://github.com/nibblescreative-afk/darkseek
```

Or compare hashes yourself:

```sh
solana-verify build --library-name darkseek_vault \
  --base-image solanafoundation/solana-verifiable-build:4.3.0@sha256:12fd4c0a0790f0fc41ef74b0cdb6bccc167ba6137eb1adb749bac649481c86bd
solana-verify get-executable-hash target/deploy/darkseek_vault.so
solana-verify get-program-hash --url https://api.devnet.solana.com <program id>
# without solana-verify: the same hash from the SDK
npm run verify -- program --cluster devnet --program <program id> --so target/deploy/darkseek_vault.so
```

Both hashes are sha256 of the program bytes with trailing zero padding
removed. The last command also prints the upgrade authority: compare it with
the one in [deployments.md](deployments.md) and read the upgrade plan in
[security-model.md](security-model.md#the-upgrade-authority).

The program also carries a `security.txt` (shown by Solana explorers) that
points back to this repository.

## 2. A release is what the workflow built

Each tagged release has these assets:

| Asset | What |
|---|---|
| `darkseek_vault.so` | the program, from the verifiable build |
| `darkseek_vault.json` | the IDL |
| `darkseek-sdk-<version>.tgz` | the SDK, as `npm pack` produced it |
| `SHA256SUMS` | sha256 of every asset above |
| `web-build.json` | the website build manifest (see 5), once the site is released |

The release workflow signs build provenance for every asset with
[GitHub artifact attestations](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations):
proof that the file came from this repository's workflow at that commit.

```sh
scripts/verify-release.sh v0.2.0                                          # download, check SHA256SUMS and attestations
scripts/verify-release.sh v0.2.0 --cluster devnet --program <program id>  # and compare the .so with the chain
```

The script needs `curl` and `sha256sum`; it checks attestations when the
GitHub CLI (`gh`) is installed and logged in, and the chain when Node is
available.

## 3. The settings are the published ones

```sh
npm run verify -- config --cluster devnet --program <program id> --usdc-mint <mint> --ds-mint <mint> \
  --launch-buy-usdc <USDC base units from deployments.md>
```

Checks the fee (10% of every stake), its split (of the fee: 10% to stakers,
20% to the loser rebate, 20% to buyback and burn, 50% to the treasury; that is
1%, 2%, 2% and 5% of every stake), the stakes (0.50 and 1.50 casual, 2.50 and
7.50 pro), the stake token and the $DS mint against the published values, and
prints the admin and game server keys. It also checks the buyback rule: that
the first target is half the launch buy published in deployments.md, and that
the current target is the first one times 0.98 for every completed round,
rounded down at each step. None of these can change without a program
upgrade, except the game server key (`set_authority`, an event in the
program's history).

## 4. $DS has a fixed supply; characters are one of one

```sh
npm run verify -- ds-mint --cluster devnet --ds-mint <$DS mint>
```

$DS is created by pump.fun, on SPL Token or on Token 2022. Either way it must
have no mint authority (no more can ever be minted), no freeze authority
(nobody can freeze holders), six decimals and a supply of at most
1,000,000,000 (lower only by the buyback burn; the command prints how much has
been burned). A Token 2022 mint may carry its metadata and no other extension.
With the Solana CLI: `spl-token display <$DS mint>` shows the same.

There are no allocations to check: the only wallet the team announces is the
launch buy wallet in [deployments.md](deployments.md). If the team locks any
of its tokens, that lock is listed there too and can be read with the SDK
(`DarkSeekReader.vesting(mint, beneficiary, id)`): total, cliff, end and what
has been claimed.

```sh
npm run verify -- nft --cluster devnet --mint <character mint> [--update-authority <key>]
```

A character must be a Token 2022 mint with a supply of exactly 1, no decimals,
no mint authority (no second copy can exist), no freeze authority, its metadata
stored in the mint itself, and none of the extensions that could take, freeze,
tax or lock it after you buy it (permanent delegate, transfer hook, transfer
fee, non transferable, default frozen state, pausable, confidential transfers,
close authority).

## 5. A website runs the released build

The game's website is private (see the [README](../README.md#what-is-not-here)),
but what a site serves is public. With each release of the website the team
publishes a manifest of its build: the sha256 of every file the site serves,
and one hash over the whole manifest, printed in the release notes. The site
serves the same manifest at `/.well-known/darkseek-build.json`.

```sh
scripts/verify-release.sh v0.2.0 --web https://<site>
```

downloads the manifest from the site, checks that it is the one attached to
the release, then downloads every file it lists and checks each hash. A
mismatch means the site serves something other than the published build.
`scripts/web-manifest.ts <dist dir>` writes such a manifest from any build
directory.

This proves the site serves exactly the build published with the release, so
it cannot change quietly between releases. It does not show what the private
code does; the guarantees about money come from the program, which needs none
of it.

## 6. Solvency, right now

```sh
npm run verify -- solvency --cluster devnet --program <program id>
```

Reads every vault, room and pool and checks the invariants in
[solvency.md](solvency.md). The indexer serves the same report at
`GET /solvency`.

## 7. Every round and every fill

Every movement of value logs an event (`RoundStarted`, `RoundSettled`,
`Buyback`, ...). The indexer (`apps/indexer`) follows the program and serves
totals per room and round; you can run your own copy against any RPC endpoint
and compare it with the program's own running totals (`config.totals`).
