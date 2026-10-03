-- Първоначална схема за HEROS търговията.

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  status        TEXT NOT NULL DEFAULT 'idle',   -- idle | running | paused | stopped | error
  symbol        TEXT,
  timeframe     TEXT,
  model         INTEGER,
  account_login TEXT,
  config        JSONB
);

CREATE TABLE IF NOT EXISTS trades (
  id         BIGSERIAL PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  opened_at  TIMESTAMPTZ,
  closed_at  TIMESTAMPTZ,
  symbol     TEXT,
  direction  TEXT,
  lot        NUMERIC,
  entry      NUMERIC,
  exit       NUMERIC,
  sl         NUMERIC,
  tp         NUMERIC,
  pnl        NUMERIC,
  reason     TEXT,
  mt5_ticket BIGINT
);

CREATE TABLE IF NOT EXISTS equity_snapshots (
  id             BIGSERIAL PRIMARY KEY,
  session_id     TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  ts             TIMESTAMPTZ NOT NULL DEFAULT now(),
  equity         NUMERIC,
  balance        NUMERIC,
  floating       NUMERIC,
  open_positions INTEGER
);

CREATE INDEX IF NOT EXISTS idx_trades_session ON trades(session_id, opened_at);
CREATE INDEX IF NOT EXISTS idx_equity_session ON equity_snapshots(session_id, ts);
