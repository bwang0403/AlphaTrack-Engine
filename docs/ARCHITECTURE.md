# AlphaTrack v2 architecture

## Design goals

AlphaTrack v2 prioritizes correctness and demonstrable failure handling over simulated visual activity. The system must preserve these invariants:

1. A `(user-owned account, idempotency key)` pair identifies at most one order.
2. One accepted order can create at most one trade.
3. Cash and position quantities cannot become negative.
4. The server selects execution prices and owns every balance mutation.
5. Missing, stale, malformed, or unavailable market data stays visible as an error state.

## Components

### React client

The client renders market data, paper-order entry, positions, order history, and live system observations. It offers username/passcode registration and login plus one-click demo user sign-in. It sends only an order symbol, side, whole-share quantity, and idempotency key.

### Worker API

The Worker owns validation, user authentication, session verification, provider access, response shaping, and persistence. Registered passcodes use salted, peppered PBKDF2-SHA-256; a 256-bit random cookie token is verified against its peppered hash in D1 and bound to a `user_id`. API errors use a stable code, safe message, and request ID. Provider credentials are Worker secrets and are never sent to the client.

### Alpaca adapter

The adapter requests the free IEX feed, normalizes bars, rejects invalid timestamps and non-finite values, and adds provider/freshness metadata. An unavailable provider produces an API error rather than generated data.

### D1 ledger

Money is stored as integer cents and the initial paper balance is `$100,000.00`. The schema separates accounts, sessions, orders, positions, and immutable trades. Unique constraints enforce session and order identities.

D1 also stores fixed-window counters for registration, login, demo sign-in, market reads, and order submission. Cloudflare's trusted client-address header scopes unauthenticated limits; authenticated order limits use the verified `user_id`. A daily scheduled handler removes expired sessions, old inactive demo users with no trade records and their accounts, and old rate-limit buckets; traded accounts retain their immutable ledger records.

### Queue worker

New orders are written to D1 before their command enters the queue. The consumer claims `PENDING` orders by moving them to `PROCESSING`, obtains a server-side price, and atomically inserts a unique trade, applies guarded ledger mutations, and marks the order `FILLED`. Business-rule failures become `REJECTED`. Provider or database failures return the order to `PENDING` for queue retry with bounded exponential delay. A five-minute scheduled check requeues orders stalled for over ten minutes. Exhausted messages go to the configured dead-letter queue; the app does not expose live queue or DLQ metrics.

Queue concurrency is set to one for this single-ledger demo. The database's unique trade key and trade-ID-guarded mutations provide the final replay protection even when a stalled claim is recovered while its original worker resumes. A future multi-tenant version can shard account commands by account ID through stateful per-account coordinators.

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
- The portfolio reports server-derived realized P&L from filled trades. Live equity and unrealized P&L are displayed only when every position has a verified current quote; otherwise the UI keeps market valuation pending rather than inventing a price.
- Username/passcode accounts and one-click demo user sign-in use seven-day sessions; password recovery and third-party identity providers are not implemented.
- The System view fetches live D1 order counts, session status, rate-limit policies, and market observations. Queue and DLQ depth remain unavailable through the current Worker binding.
- The legacy Python Lambda remains in the repository during migration and is not used by the v2 Worker.
