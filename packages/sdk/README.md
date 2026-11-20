# @darkseek/sdk

Read, build and verify everything the DarkSeek vault program does, in
TypeScript, with `@solana/web3.js` 1.x and no other Solana library. Releases
attach it as `darkseek-sdk-<version>.tgz`; it is not published to a registry.

```ts
import { Connection, PublicKey } from '@solana/web3.js';
import { DarkSeekReader, VaultInstructions, checkSolvency, parseEvents, payoutsFor, PUBLISHED } from '@darkseek/sdk';

const programId = new PublicKey('<program id from docs/deployments.md>');
const conn = new Connection('https://api.devnet.solana.com');
const reader = new DarkSeekReader(conn, programId);

const config = await reader.config();           // fee, split, pools, $DS, auction, running totals
const vault = await reader.vault(wallet);       // balance, locked, session, $DS, staking rewards
const quote = await reader.quote(100_000_000n); // what selling 100 $DS to the auction pays now

const ix = new VaultInstructions(programId).withdraw(wallet, config.mint, 5_000_000n);
const sell = new VaultInstructions(programId).sellDs(seller, config.mint, config.dsMint, 100_000_000n, 0n, config.dsTokenProgram);
const events = parseEvents(transaction.meta.logMessages, programId);   // RoundSettled, Buyback, ...
const report = await checkSolvency(conn, programId);                   // custody covers every balance

// the payout rules, base unit for base unit with the program
payoutsFor(PUBLISHED.stakes, PUBLISHED.feeBps, 0, [0, 0, 0, 1, 0xff, 0xff, 0xff, 0xff]);
```

| Module | |
|---|---|
| `layouts`, `accounts`, `events`, `errors` | every account, event and error of the program, checked against the IDL in the tests |
| `instructions`, `pda` | a builder for every instruction, account order and flags as the program checks them |
| `rules` | fee, split, payouts, losers and rebate credit, rebate claims, staking rewards, the buyback target and round, auction price and fill, vesting |
| `tokenomics` | the same rules in USDC for display: room economics, settlement, live estimates |
| `verify` | solvency (rebate credits included), settings against the white paper, the buyback target rule, program hash and upgrade authority, the $DS mint (SPL Token or Token 2022), character NFTs |
| `spl` | SPL Token and Token 2022 decoders (extensions included) and the few token instructions the scripts use |
| `explorer` | Solscan links |

`PROGRAM_ID` and `DEMO_DEFAULTS` are devnet demo placeholders, not a
deployment; pass the program id of a deployment listed in
[docs/deployments.md](../../docs/deployments.md).

The `darkseek-verify` command runs the checks from a terminal; see
[docs/verify.md](../../docs/verify.md).
