## What and why

<!-- What this changes, and why. Link the issue if there is one. -->

## Money paths

<!-- Does this change who can move value, how much, or when? If yes, say how. -->

- [ ] No change to the program
- [ ] The program changes, and `docs/security-model.md` and `tests/source.test.ts` describe the new behavior
- [ ] An invariant in `docs/solvency.md` changes

## Checks

- [ ] `npm test`, `npm run test:program` and `npm run test:indexer` pass
- [ ] The IDL is rebuilt (`scripts/build-idl.sh`) if the program changed
- [ ] Docs and the white paper match the code
- [ ] `scripts/scan-secrets.sh` is clean
- [ ] `CHANGELOG.md` says what the game server has to do differently, if anything
