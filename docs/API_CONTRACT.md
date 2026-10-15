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

## Sessions

### `POST /api/session`

Creates an isolated paper account with `$100,000.00`, persists a hash of an opaque session token, and sets an HTTP-only, same-site cookie. Production cookies are also `Secure`.

Returns `201` with session expiry and starting cash. The raw token and account ID are not returned in JSON.

Session creation is limited per Cloudflare-supplied client address. Excess requests return `429 RATE_LIMITED`.

### `GET /api/session`

Validates the current cookie. Returns `200` with session expiry or `401` when missing or expired.

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

Requires a demo session. Returns integer-cent cash, ledger version, and server-owned positions. The client never submits balances or positions.

## Orders

### `POST /api/orders`

Requires `Content-Type: application/json` and a demo session.

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
- `429`: the authenticated demo account exceeded the order submission limit.

### `GET /api/orders`

Returns up to 100 orders for the authenticated demo account. Internal account IDs and idempotency keys are not included.

Order states are `PENDING`, `PROCESSING`, `FILLED`, and `REJECTED`; there is no separate `QUEUED` or `FAILED` state.

## Health

### `GET /api/health`

Checks Worker and D1 reachability and returns environment and timestamp. It does not expose secrets or internal resource identifiers.

## Legacy contract

`lambda_function.py` and `app.html` implement the v1 analysis contract and remain only as migration references. The v2 client does not use query-string trade actions, frontend-supplied prices, or frontend-supplied user IDs.
