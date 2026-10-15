# AlphaTrack

AlphaTrack is a deployed market-data and **paper-trading** terminal. The current app runs on [Cloudflare Workers](https://alphatrack-engine.brucecollege4success.workers.dev), uses Alpaca's IEX feed for stock prices, and keeps simulated cash and positions in D1. It does not route real-money orders or provide investment advice.

The engineering focus is order correctness under retries: one account-scoped idempotency key identifies one request, a unique trade constraint prevents a repeated queue message from posting a second fill, and the browser cannot provide the execution price or account balance. The terminal shows data provenance and failure states instead of inventing prices when Alpaca is unavailable.

## Architecture overview

```text
React/TypeScript terminal
  ├─ GET /api/market/:symbol ──> Cloudflare Worker ──> Alpaca IEX
  └─ registration / sign-in / portfolio / orders ──> Worker ──> D1
                                               └─> Cloudflare Queue
                                                      └─> order consumer ──> D1 ledger
                                                               └─> dead-letter queue after retry exhaustion
```

The Worker serves the built frontend and API from one origin. `wrangler.jsonc` binds D1, the order queue, a dead-letter queue, and scheduled recovery. Queue consumption is configured with one concurrent invocation and batches of up to ten messages; the handler processes each message sequentially. The System view fetches current D1 order-state counts, authenticated-user status, rate-limit policies, API/D1 health, and Alpaca provenance and freshness every 30 seconds. Queue and DLQ depth are marked unavailable because Cloudflare does not expose those metrics through the current Worker bindings.

## Order lifecycle and idempotency

1. `POST /api/orders` accepts a symbol, side, positive whole-share quantity, and idempotency key. D1 enforces `UNIQUE(account_id, idempotency_key)`. Replaying an identical request returns the original order; reusing the key for different order details returns `409`.
2. The persisted order starts `PENDING`. The queue consumer claims it with a conditional `PENDING → PROCESSING` update and fetches the execution price from Alpaca on the server.
3. A D1 transaction inserts a trade with `UNIQUE(order_id)`, updates integer-cent cash and position values only when **that insertion** succeeds, and marks the order `FILLED`. Insufficient cash or shares produces `REJECTED` without a trade.
4. Provider or database errors reset the claim to `PENDING` for queue retry. A five-minute scheduled check requeues pending or processing orders stalled for more than ten minutes. The queue also has a configured dead-letter queue; this repository does not claim automated DLQ alerting.

Orders use these states: `PENDING → PROCESSING → FILLED` or `REJECTED`. There is no separate `QUEUED` or `FAILED` state. The queue can deliver a message more than once; the D1 trade constraint and transaction guard prevent a second cash or position mutation for the same order.

## Ledger and authentication

D1 stores cash, average cost, and fill prices as integer cents. Schema `CHECK` constraints prohibit negative account cash or position quantity. Every portfolio and order query is scoped to the authenticated `user_id` obtained from a validated session cookie; the client does not send user IDs, cash, holdings, or execution prices. The account ID is the user's ID, so one user owns one isolated paper ledger.

Users may register with a username and passcode, sign in later, or choose **Instant Demo Account Sign-In** for immediate recruiter access. Registered passcodes are salted and peppered with 210,000-iteration PBKDF2-SHA-256 before storage. Each sign-in receives a 32-byte cryptographically random session token in an `HttpOnly`, `SameSite=Strict` cookie (`Secure` over HTTPS). D1 stores only a peppered SHA-256 token hash and binds that session to a `user_id`. Demo users use the same user and session tables, with a fresh isolated paper ledger. Registration, login, demo sign-in, market reads, and order submissions have D1-backed rate limits; client addresses are pepper-hashed before storage.

## Market-data provenance

The API supports `5d`, `1mo`, `3mo`, `6mo`, and `1y` lookback selections. It requests daily bars and the latest trade from Alpaca's free `iex` feed, validates timestamps and finite OHLCV numbers, and returns `provider`, `feed`, source time, receive time, and `LIVE` / `DELAYED` / `STALE` freshness. `LIVE` means the latest trade is at most one minute old; delayed data is labeled as such. Empty, malformed, or unavailable provider data returns an explicit error. No synthetic market-data fallback exists in the current React/Worker app.

## Run and verify locally

Use Node.js 22+. Copy `.dev.vars.example` to `.dev.vars` and add Alpaca market-data credentials plus a random session pepper. `.dev.vars` is Git-ignored. Then run:

```bash
npm ci
npm run db:migrate:local
npm test
npm run typecheck
npm run build
```

`npm test` is the **primary suite: exactly 35 deterministic TypeScript tests**, without AWS, Alpaca, or other network calls. It covers validation, provider failures, registration/login/session verification, rate-limit keys, integer-cent ledger policy, and in-memory SQLite execution of the actual D1 migrations. A request-to-ledger test exercises the Worker HTTP router, demo authentication, buy and sell submissions, Queue consumer, D1 fills, and idempotent replay of **both** sides. Other tests cover duplicate queue delivery, overdraft rejection, and recovery of a stalled claim while the original worker resumes. GitHub Actions runs the same TypeScript tests, type-check, and build. The separate Python suite characterizes retained v1 code and is not part of the 35-test TypeScript count.

For development, run `npm run dev:api` and `npm run dev` in separate terminals. Vite serves the UI at `http://127.0.0.1:5173` and proxies `/api` to the local Worker. The current deployment and environment bindings are in `wrangler.jsonc`; secrets are configured in Cloudflare and never committed.

The dependency-free `npm run verify:deployment -- http://127.0.0.1:8787 full` script checks the built page, health, demo authentication, System API, Alpaca IEX data, and HTTP-to-queue buy/sell fills with idempotent replay. `npm run verify:browser -- http://127.0.0.1:8787` uses installed headless Chrome to click the demo sign-in and inspect the rendered System view. Both commands also accept the live Worker URL.

## Repository map

| Path | Purpose |
| --- | --- |
| `src/client/` | React terminal, chart, API client, portfolio, orders, System view |
| `src/worker/` | HTTP API, Alpaca adapter, sessions, rate limiting, orders, ledger |
| `migrations/` | D1 schema and rate-limit counters |
| `tests-ts/` | Deterministic TypeScript unit and SQLite-backed pipeline tests |
| `docs/` | API contract, architecture, and threat model |
| `app.html`, `lambda_function.py`, `tests/` | Retained v1 code and characterization tests; not used by the current Worker app |

The portfolio presents cash plus **cost basis**, not a live-marked portfolio value. The app supports whole-share paper market orders, registered user accounts, and one-click demo user sign-in. It does not route real-money orders.
