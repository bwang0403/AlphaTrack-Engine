# Threat model

## Protected assets

- Alpaca API credentials
- User passcode hashes and session tokens
- Server-owned cash, positions, orders, and trades
- Market-data provenance and timestamps
- Order uniqueness and ledger correctness

## Trust boundaries

The browser is untrusted. Symbols, sides, quantities, idempotency keys, cookies, and all headers can be forged or replayed. Provider responses are also validated before use. D1 and Queue bindings are available only to the Worker.

## Controls

| Risk | Control |
| --- | --- |
| Client changes a balance or holding | No balance, position, account ID, or execution-price fields exist in the write contract |
| Session enumeration | 256-bit random token; only its SHA-256 hash plus a secret pepper is stored and bound to `user_id` |
| Passcode theft or brute force | Salted, peppered PBKDF2-SHA-256 at 210,000 iterations; fixed-window registration and login rate limits |
| Cross-site session use | SameSite=Strict cookie; same-origin API; production Secure cookie |
| Duplicate click or network replay | Unique `(account_id, idempotency_key)` database constraint |
| Queue at-least-once replay | Conditional `PENDING → PROCESSING` claim, unique trade per order, and transaction mutations guarded by the newly inserted trade ID |
| Overspending or overselling | Server-side integer arithmetic and ledger policy validation |
| Invalid JSON numbers | Non-finite provider values rejected before response serialization |
| Secret disclosure | Worker secrets only; `.dev.vars` ignored; no keys in browser or repository |
| Provider outage | Explicit error or retry; no synthetic price fallback |
| Abandoned order after interrupted queue send or worker execution | Five-minute scheduled recovery requeues orders whose `PENDING` or `PROCESSING` state is over ten minutes old |
| Abuse of public demo | D1-backed fixed-window limits for demo sign-in, registration, login, market reads, and order creation; client addresses are peppered and hashed before persistence |
| Unbounded unused demo data retention | Daily scheduled cleanup removes expired sessions, old inactive demo accounts without trades and their users, and old rate-limit buckets; trade records remain immutable |

## Required before public deployment

- Set a production session pepper through Worker secrets.
- Use least-privilege Alpaca market-data credentials.
- Verify CORS remains same-origin.
- Configure Queue dead-letter monitoring and retention expectations; the System view does not expose live Queue metrics.
- Run concurrency, replay, and load tests against the deployed free-tier limits.
