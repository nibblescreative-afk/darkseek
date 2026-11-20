# DarkSeek indexer

Follows the DarkSeek vault program through any Solana RPC endpoint, stores
every event it logs in SQLite and serves read only totals. Anyone can run it;
compare its numbers with the program's own running totals (`/stats` shows both).

## Run

```sh
npm ci
npm run build -w @darkseek/sdk -w @darkseek/indexer
DS_RPC_URL=<rpc url> DS_PROGRAM_ID=<program id> npm start -w @darkseek/indexer
```

or with Docker, from the repository root:

```sh
docker build -f apps/indexer/Dockerfile -t darkseek-indexer .
docker run -p 8080:8080 -v darkseek-indexer:/data -e DS_RPC_URL=<rpc url> -e DS_PROGRAM_ID=<program id> darkseek-indexer
```

| Variable | Default | |
|---|---|---|
| `DS_RPC_URL` | `https://api.devnet.solana.com` | any RPC endpoint |
| `DS_PROGRAM_ID` | the devnet deployment | the deployment to follow ([deployments.md](../../docs/deployments.md)) |
| `DS_CLUSTER` | `devnet` | for Solscan links |
| `DS_COMMITMENT` | `finalized` | `confirmed` is faster but can, rarely, see a block that is dropped |
| `DS_DB_PATH` | `data/indexer.sqlite` | |
| `DS_POLL_MS` | `2000` | |
| `DS_SOLVENCY_CACHE_MS` | `30000` | how long `/solvency` reuses a result |
| `PORT`, `HOST` | `8080`, `0.0.0.0` | |

Nothing is deployed yet, so the default program id follows nothing; the
indexer says so in its log.

## API

All responses are JSON; amounts are strings of base units (USDC and $DS both
have six decimals).

| Route | |
|---|---|
| `GET /health` | last slot indexed, last sync, last error |
| `GET /stats` | rounds, stakes and fees by bucket, by tier; buyback fills and $DS burned; rebates credited, claimed and paid in $DS; staking; vault flows; beside them the program's own `totals`, pools, buyback target and rounds done |
| `GET /rounds?room=&limit=` | recent rounds |
| `GET /rounds/:room/:round` | one round: seats and owners, fee split, outcome, payouts, refunds, rebate credit per seat, Solscan links |
| `GET /solvency` | the SDK's solvency check, live |
| `GET /events?name=&limit=&before_slot=` | raw events |

## How it works

It pages the program's transaction signatures from the last one stored to the
newest, fetches each transaction and decodes the `Program data:` lines the
program itself logged (`parseEvents` in the SDK). Failed transactions are
skipped. A transaction's events and the cursor are written in one SQLite
transaction, and events are keyed by signature and position, so a restart
never loses or doubles anything.

Test: `npm run test:indexer` from the repository root (starts a local validator).
