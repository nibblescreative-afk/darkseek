# Releasing

How a version of the protocol goes from a commit to the chain, so that every
step leaves something anyone can check.

## 1. Prepare

- Bump the version in `programs/darkseek-vault/Cargo.toml`,
  `packages/sdk/package.json` and `apps/indexer/package.json`.
- Run `scripts/build-idl.sh` and commit the IDL if it changed. CI fails when
  the SDK and the IDL disagree.
- Update `CHANGELOG.md`: what changed onchain, what the game server must do
  differently, and any change to the docs' numbers.
- Merge to `main` with CI green.

## 2. Tag

```sh
git tag -s v0.2.0 -m "v0.2.0"
git push origin v0.2.0
```

The `release` workflow then:

1. builds the program with `solana-verify build` in the pinned image
   (`solanafoundation/solana-verifiable-build:4.3.0@sha256:12fd4c...86bd`);
2. builds the IDL and checks it matches the committed one;
3. runs the SDK tests and packs the SDK (`npm pack`);
4. writes `SHA256SUMS` for the program, the IDL and the SDK tarball;
5. attests build provenance for each of them (`actions/attest-build-provenance`);
6. creates a draft GitHub release with the assets and the program hash in its notes.

A maintainer reviews the draft and publishes it.

## 3. Publish the website build manifest

The website is built in its private repository. For the release:

```sh
npx tsx scripts/web-manifest.ts path/to/site/dist > web-build.json
```

Attach `web-build.json` to the release, add its `root` hash to the release
notes, and deploy the site with the same file at
`/.well-known/darkseek-build.json`. Check the live site afterwards:

```sh
scripts/verify-release.sh v0.2.0 --web https://<site>
```

## 4. Deploy the program

The owner deploys with their own wallet; anything with real money goes
through the multisig.

```sh
solana program write-buffer darkseek_vault.so --url <cluster>          # from the release asset
solana program set-buffer-authority <buffer> --new-buffer-authority <multisig vault>
```

Propose the upgrade in Squads with that buffer. Before approving, each signer
checks the buffer:

```sh
solana-verify get-buffer-hash --url <cluster> <buffer>   # must equal the release hash
```

After the timelock and the upgrade:

```sh
scripts/verify-release.sh v0.2.0 --cluster <cluster> --program <program id>
```

Then update [deployments.md](deployments.md) if an address changed, and
announce the release with its program hash and web build hash.

## 5. If something is wrong

A release that fails any check is not deployed. A deployed program found
vulnerable is handled under [SECURITY.md](../SECURITY.md); the fix ships as a
new release through the same steps (the timelock still applies, so players
can withdraw first).
