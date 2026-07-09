-- Huddle schema: users, polls, slots, votes, magic-link tokens.
-- Applied manually (local dev via psql, prod via `fly postgres connect`).

CREATE TABLE IF NOT EXISTS users (
  id          BIGSERIAL PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  plan        TEXT NOT NULL DEFAULT 'free'
);

-- Phase 3 (billing): links a user to their Stripe customer/subscription.
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;

CREATE TABLE IF NOT EXISTS magic_link_tokens (
  token       TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_magic_link_tokens_email ON magic_link_tokens(email);

CREATE TABLE IF NOT EXISTS polls (
  id              TEXT PRIMARY KEY,
  owner_id        BIGINT NOT NULL REFERENCES users(id),
  type            TEXT NOT NULL DEFAULT 'schedule'
                    CHECK (type IN ('schedule','question','rsvp','availability')),
  title           TEXT NOT NULL,
  creator_name    TEXT NOT NULL DEFAULT '',
  description     TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL,
  deadline        BIGINT,
  expected_voters TEXT[] NOT NULL DEFAULT '{}',
  confirmed_slot  TEXT
);
CREATE INDEX IF NOT EXISTS idx_polls_owner_id ON polls(owner_id);

CREATE TABLE IF NOT EXISTS slots (
  id            BIGSERIAL PRIMARY KEY,
  poll_id       TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  slot_key      TEXT NOT NULL,
  datetime      BIGINT,
  end_datetime  BIGINT,
  label         TEXT,
  sort_order    INT NOT NULL,
  UNIQUE (poll_id, slot_key)
);

CREATE TABLE IF NOT EXISTS votes (
  id            BIGSERIAL PRIMARY KEY,
  poll_id       TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  name_lower    TEXT GENERATED ALWAYS AS (lower(name)) STORED,
  timezone      TEXT NOT NULL,
  responses     JSONB NOT NULL,
  submitted_at  TIMESTAMPTZ NOT NULL,
  UNIQUE (poll_id, name_lower)
);
CREATE INDEX IF NOT EXISTS idx_votes_poll_id ON votes(poll_id);
