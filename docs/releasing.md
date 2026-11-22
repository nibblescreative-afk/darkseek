# Releasing

How a version of the vault program goes from a commit to the chain, so that
every step leaves something anyone can check.

## 1. Prepare

- Bump the version in `programs/darkseek-vault/Cargo.toml`,
  `packages/sdk/package.json` and `apps/indexer/package.json`.
- Run `scripts/build-idl.sh` and commit the IDL if it changed. CI fails when
  the SDK and the IDL disagree.
- Update `CHANGELOG.md`: what changed onchain, what the game server must do
  differently, and any change to the docs' numbers.
- Merge to `main` with CI green. The Validator workflow builds the program the
  way the release will and runs every test on those bytes; its "Program build"
  notice gives the program hash, size and SBPF version, so the release hash is
  known before the tag.

## 2. Tag

```sh
git tag -s v0.2.0 -m "v0.2.0"
git push origin v0.2.0
```

The `release` workflow then:

1. builds the program with `scripts/build-program.sh --verifiable`, which runs
   `solana-verify build --arch v3` in the image pinned there
   (`solanafoundation/solana-verifiable-build:4.3.0@sha256:12fd4c...86bd`) and
   fails unless the program is SBPF v3;
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

Releases after v0.4.1 are SBPF v3; v0.4.1 and earlier are SBPF v0. Once
SIMD-0500 is active the clusters refuse to deploy SBPF v0, v1 and v2 programs,
upgrades included. A deployed SBPF v0 program still upgrades in place to an
SBPF v3 build, keeping its program id and accounts (`tests/upgrade.test.ts`
does it from each release a cluster runs). The program
data must be at least as large as the new `.so`; if it is not, extend it first
(`solana program extend`), in an earlier slot than the upgrade.

```sh
scripts/sbpf-version.sh darkseek_vault.so                              # SBPF v3 (e_machine 247, e_flags 3)
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
