# AlphaTrack v2 API contract

All v2 routes are same-origin under `/api`. Successful and error bodies are strict JSON. Error responses use:

```json
{
  "error": {
    "code": "STABLE_MACHINE_CODE",
    "message": "Safe human-readable message",
    "requestId": "request correlation ID"
  }
}
```

## Authentication and sessions

`POST /api/auth/register` accepts JSON `{ "username": "alice", "passcode": "at-least-ten-characters" }`, creates a registered user and paper ledger, and returns `201` with a user ID, username, and session expiry. `POST /api/auth/login` accepts the same fields and returns `200` with a new session cookie. Duplicate usernames return `409`; invalid credentials return `401`. Both routes are rate limited.

`POST /api/auth/demo` creates a demo user with a server-owned `user_id` and isolated ledger, then signs that user in with the same cookie mechanism. `GET /api/auth/me` verifies the current cookie and returns the user ID, account kind, and expiry. `POST /api/auth/logout` removes the token hash and clears the cookie.

### `POST /api/session`

Compatibility alias for one-click demo sign-in. Creates an isolated paper user and account with `$100,000.00`, persists a peppered hash of an opaque session token bound to `user_id`, and sets an HTTP-only, same-site cookie. Production cookies are also `Secure`.

Returns `201` with session expiry and starting cash. The raw token and account ID are not returned in JSON.

Session creation is limited per Cloudflare-supplied client address. Excess requests return `429 RATE_LIMITED`.

### `GET /api/session`

Compatibility alias for `GET /api/auth/me`. Returns `200` with authenticated user identity and session expiry or `401` when missing or expired.

## Market data

### `GET /api/market/:symbol?period=1mo`

Supported periods: `5d`, `1mo`, `3mo`, `6mo`, and `1y`.

The success body contains:

- `symbol`, `price`, `change`, and `changePercent`
- `asOf` and `receivedAt`
- `provider: "alpaca-iex"` and `feed: "iex"`
- `freshness: "LIVE" | "DELAYED" | "STALE"`
- normalized OHLCV `bars`

Expected errors include `INVALID_SYMBOL`, `INVALID_PERIOD`, `PROVIDER_NOT_CONFIGURED`, `PROVIDER_UNAVAILABLE`, `PROVIDER_ERROR`, `INVALID_PROVIDER_DATA`, and `MARKET_DATA_NOT_FOUND`.

Market reads are rate limited per Cloudflare-supplied client address. Excess requests return `429 RATE_LIMITED`.

## Portfolio

### `GET /api/portfolio`

Requires an authenticated user session. Returns integer-cent `cashCents`, `realizedPnlCents`, ledger `version`, and server-owned `positions` for that `user_id`. `realizedPnlCents` is cumulative profit/loss from that user's filled sells, reconstructed in fill order using the same rounded weighted-average cost basis as the ledger. It is `0` until a sell fills. The client never submits balances or positions.

## Orders

### `POST /api/orders`

Requires `Content-Type: application/json` and an authenticated user session.

```json
{
  "symbol": "NVDA",
  "side": "BUY",
  "quantity": 2,
  "idempotencyKey": "a-client-generated-uuid"
}
```

Only positive whole-share quantities are accepted. Price, balance, account ID, status, and fill data are deliberately absent from the request.

- `202`: a new order was persisted and queued.
- `200`: the same idempotency key returned its existing order with `replayed: true`.
- `409`: an existing idempotency key was reused with different order details.
- `400`: validation failed.
- `401`: session missing or expired.
- `415`: body is not JSON.
- `429`: the authenticated user exceeded the order submission limit.

### `GET /api/orders`

Returns up to 100 orders per page for the authenticated user. Each order includes its original `idempotencyKey` so the owner can replay the same symbol, side, and quantity. The response also contains `nextCursor` (an order ID or `null`); pass a non-null cursor as `GET /api/orders?cursor=...` to load older orders. The cursor must belong to the authenticated user. Internal account IDs are not returned.

### `GET /api/orders/:id`

Returns `{ "order": ... }` for one order owned by the authenticated user, including its `idempotencyKey`. An absent order or another user's order returns `404 ORDER_NOT_FOUND`.

Order states are `PENDING`, `PROCESSING`, `FILLED`, and `REJECTED`; there is no separate `QUEUED` or `FAILED` state.

## Health

### `GET /api/health`

Checks Worker and D1 reachability and returns environment and timestamp. It does not expose secrets or internal resource identifiers.

### `GET /api/system`

Requires authentication. Returns current D1 order-state counts scoped to the authenticated user, D1 reachability, session kind and expiry, configured Queue binding status, and the effective rate-limit policy. Queue and DLQ depth are `null` when unavailable, rather than invented. The client separately fetches current Alpaca market data, provenance, and freshness for the System view.

## Legacy contract

`lambda_function.py` and `app.html` implement the v1 analysis contract and remain only as migration references. The v2 client does not use query-string trade actions, frontend-supplied prices, or frontend-supplied user IDs.
