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
  expected_voters JSONB NOT NULL DEFAULT '[]',
  confirmed_slot  TEXT
);
CREATE INDEX IF NOT EXISTS idx_polls_owner_id ON polls(owner_id);

-- Phase 5 (chase-the-voter): expected_voters becomes structured [{name, email?}]
-- instead of bare names, so nudges/reminders have somewhere to send.
-- Guarded so it's safe to re-run against a table that's already converted.
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'polls' AND column_name = 'expected_voters') = 'ARRAY' THEN
    -- ALTER ... TYPE USING can't contain a correlated aggregate subquery, so
    -- convert via a temp column + UPDATE instead of a direct type change.
    ALTER TABLE polls ADD COLUMN expected_voters_new JSONB;
    UPDATE polls SET expected_voters_new = (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('name', v)), '[]'::jsonb)
      FROM unnest(expected_voters) AS v
    );
    ALTER TABLE polls DROP COLUMN expected_voters;
    ALTER TABLE polls RENAME COLUMN expected_voters_new TO expected_voters;
    ALTER TABLE polls ALTER COLUMN expected_voters SET NOT NULL;
    ALTER TABLE polls ALTER COLUMN expected_voters SET DEFAULT '[]';
  END IF;
END $$;

-- Phase 5: dedupes the deadline-reminder sweep so it only fires once per poll.
ALTER TABLE polls ADD COLUMN IF NOT EXISTS deadline_reminder_sent_at TIMESTAMPTZ;

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
