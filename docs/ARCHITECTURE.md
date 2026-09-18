# AlphaTrack v2 architecture

## Design goals

AlphaTrack v2 prioritizes correctness and demonstrable failure handling over simulated visual activity. The system must preserve these invariants:

1. A `(demo account, idempotency key)` pair identifies at most one order.
2. One accepted order can create at most one trade.
3. Cash and position quantities cannot become negative.
4. The server selects execution prices and owns every balance mutation.
5. Missing, stale, malformed, or unavailable market data stays visible as an error state.

## Components

### React client

The client renders market data, paper-order entry, positions, order history, and system state. It creates an opaque demo session through a same-origin HTTP-only cookie. It sends only an order symbol, side, whole-share quantity, and idempotency key.

### Worker API

The Worker owns validation, session authentication, provider access, response shaping, and persistence. API errors use a stable code, safe message, and request ID. Provider credentials are Worker secrets and are never sent to the client.

### Alpaca adapter

The adapter requests the free IEX feed, normalizes bars, rejects invalid timestamps and non-finite values, and adds provider/freshness metadata. An unavailable provider produces an API error rather than generated data.

### D1 ledger

Money is stored as integer cents and the initial paper balance is `$100,000.00`. The schema separates accounts, sessions, orders, positions, and immutable trades. Unique constraints enforce session and order identities.

D1 also stores fixed-window counters for session creation, market reads, and order submission. Cloudflare's trusted client-address header scopes anonymous limits; authenticated order limits use the server-owned account ID. A daily scheduled handler removes expired sessions, anonymous accounts older than 30 days with no active session, and old rate-limit buckets.

### Queue worker

New orders are written to D1 before their command enters the queue. The consumer claims `PENDING` orders by moving them to `PROCESSING`, obtains a server-side price, applies the ledger mutation, inserts a trade, and marks the order `FILLED`. Business-rule failures become `REJECTED`. Provider failures return the order to `PENDING` and retry with bounded exponential delay. Exhausted messages go to the configured dead-letter queue.

Queue concurrency is set to one for this single-ledger demo. This avoids write races while preserving asynchronous delivery, retry, replay, and backlog behavior. A future multi-tenant version can shard account commands by account ID through stateful per-account coordinators.

## Failure behavior

| Failure | Observable result | State behavior |
| --- | --- | --- |
| Missing market credentials | `503 PROVIDER_NOT_CONFIGURED` | No generated data |
| Provider network failure | `503 PROVIDER_UNAVAILABLE` | Order returns to `PENDING` and retries |
| Provider HTTP failure | `502 PROVIDER_ERROR` | Order returns to `PENDING` and retries |
| Empty symbol history | `404 MARKET_DATA_NOT_FOUND` | No generated data |
| Duplicate order submission | Existing order returned with `replayed: true` | No second queue command |
| Insufficient cash | Order becomes `REJECTED` | Cash and positions unchanged |
| Insufficient shares | Order becomes `REJECTED` | Cash and positions unchanged |

## Current limitations

- Only whole-share market orders are supported.
- Market bars use Alpaca's free IEX feed, not consolidated SIP data.
- The portfolio screen currently reports cash plus cost basis; live portfolio valuation will be added only when every position has a verified current quote.
- Sessions are anonymous seven-day demo sessions, not identity-provider accounts.
- The legacy Python Lambda remains in the repository during migration and is not used by the v2 Worker.
