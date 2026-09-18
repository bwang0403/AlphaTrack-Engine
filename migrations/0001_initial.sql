PRAGMA foreign_keys = ON;

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  cash_cents INTEGER NOT NULL DEFAULT 10000000 CHECK (cash_cents >= 0),
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX sessions_account_id_idx ON sessions(account_id);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  order_type TEXT NOT NULL DEFAULT 'MARKET' CHECK (order_type = 'MARKET'),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'FILLED', 'REJECTED')),
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  filled_price_cents INTEGER,
  rejection_reason TEXT,
  UNIQUE (account_id, idempotency_key)
);

CREATE INDEX orders_account_time_idx ON orders(account_id, requested_at DESC);

CREATE TABLE positions (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  average_cost_cents INTEGER NOT NULL CHECK (average_cost_cents >= 0),
  version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, symbol)
);

CREATE TABLE trades (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  executed_at TEXT NOT NULL
);

CREATE INDEX trades_account_time_idx ON trades(account_id, executed_at DESC);
