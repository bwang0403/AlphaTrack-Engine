# AlphaTrack

AlphaTrack is a fault-aware market-data and paper-trading platform. It is being rebuilt around three requirements: market data must have explicit provenance, portfolio state must be server-authoritative, and failures must never be presented as successful trades.

The current v2 implementation uses a React/TypeScript client and a Cloudflare Worker API backed by D1 and Queues. Alpaca's IEX feed is the only configured market-data provider. If the provider or credentials are unavailable, the API returns an explicit error; it does not generate replacement prices.

> AlphaTrack is an educational paper-trading system. It does not place real-money orders or provide investment advice.

## What is implemented

- Real historical market bars through the Alpaca Market Data API
- Provider, feed, source timestamp, receive timestamp, and freshness metadata
- Strict symbol, period, order, quantity, and idempotency validation
- Anonymous demo sessions stored as hashed opaque tokens
- Server-owned cash balances, positions, orders, and trade ledger
- POST-only paper orders with database-enforced idempotency
- Asynchronous order processing with Cloudflare Queues
- Serialized queue consumption, replay-safe order states, retries, and a dead-letter queue
- Whole-share accounting in integer cents
- Explicit insufficient-cash and insufficient-position rejection
- Structured request and queue logs with request IDs
- React views for market data, portfolio, orders, and system health
- Unit and characterization tests that run without network or cloud access

## Architecture

```text
React client
    |
    | HTTPS / JSON
    v
Cloudflare Worker API -----> Alpaca IEX market data
    |
    +-----> D1: sessions, accounts, orders, positions, trades
    |
    +-----> Queue: accepted paper-order commands
                |
                v
          serialized order worker
                |
                +-----> server-selected quote
                +-----> atomic ledger update
```

The queue consumer is intentionally limited to one concurrent invocation. This makes ledger mutations serial while the order-state claim and unique `(account_id, idempotency_key)` constraint protect against at-least-once delivery and client replay.

See [Architecture](docs/ARCHITECTURE.md), [API contract](docs/API_CONTRACT.md), and [Threat model](docs/THREAT_MODEL.md) for the detailed design.

## Local development

Prerequisites:

- Node.js 22+
- A free Alpaca market-data account for live data

Install and validate:

```bash
npm install
npm run db:migrate:local
npm test
npm run typecheck
npm run build
```

Copy `.dev.vars.example` to `.dev.vars` and add local credentials. `.dev.vars` is ignored by Git.

Run the Worker and UI in separate terminals:

```bash
npm run dev:api
npm run dev
```

The UI is served at `http://127.0.0.1:5173` and proxies `/api` to the local Worker at `http://127.0.0.1:8787`.

## Data integrity rules

- No synthetic quote fallback exists in the v2 client or Worker.
- The client cannot supply an execution price, cash balance, position, or account ID.
- API secrets never enter the browser bundle.
- Unsupported routes and malformed inputs return structured errors.
- Non-finite provider values are rejected before JSON serialization.
- Portfolio summaries label cost basis separately from live market value.

## Repository layout

```text
src/client/          React/TypeScript user interface
src/worker/          Cloudflare Worker API and order consumer
migrations/          D1 schema migrations
tests-ts/            v2 unit and contract tests
tests/               legacy Lambda characterization tests
docs/                architecture, API, and security documentation
app.html             legacy v1 terminal retained during migration
lambda_function.py   legacy analysis Lambda retained during migration
```

## Deployment status

The v2 system is deployed on Cloudflare's free tier at:

**https://alphatrack-engine.brucecollege4success.workers.dev**

The deployment uses a D1 database, an order queue, a dead-letter queue, a daily retention job, and encrypted Worker secrets. Live credentials are intentionally absent from the repository. The deployed smoke test verifies Alpaca IEX market data, secure anonymous sessions, portfolio reads, idempotent order replay, asynchronous buy and sell fills, and a zero-position final ledger.

To deploy another environment, create the D1 and Queue resources, update the D1 ID in `wrangler.jsonc`, apply the remote migrations, configure the three secrets listed in `.dev.vars.example`, and run `npm run deploy`.
