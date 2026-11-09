-- Enrich venues/events/occurrences for automated catalogue maintenance.
-- All columns are additive and nullable/defaulted so existing rows and code are
-- unaffected; the transactional core keeps working unchanged.

-- ---- venues -----------------------------------------------------------------
ALTER TABLE venues ADD COLUMN genres text[] NOT NULL DEFAULT '{}';
ALTER TABLE venues ADD COLUMN socials jsonb NOT NULL DEFAULT '{}';
ALTER TABLE venues ADD COLUMN ticket_provider text;
ALTER TABLE venues ADD COLUMN country_code text;
ALTER TABLE venues ADD COLUMN operational_status text NOT NULL DEFAULT 'unknown'
  CHECK (operational_status IN ('active','temporarily_closed','permanently_closed','unknown'));
ALTER TABLE venues ADD COLUMN confidence numeric CHECK (confidence >= 0 AND confidence <= 1);
ALTER TABLE venues ADD COLUMN last_seen_at timestamptz;
ALTER TABLE venues ADD COLUMN last_verified_at timestamptz;
ALTER TABLE venues ADD COLUMN last_changed_at timestamptz;

CREATE TABLE venue_aliases (
  venue_id text NOT NULL REFERENCES venues(id),
  alias text NOT NULL,
  PRIMARY KEY (venue_id, alias)
);

-- ---- events -----------------------------------------------------------------
ALTER TABLE events ADD COLUMN ticket_provider text;
ALTER TABLE events ADD COLUMN confidence numeric CHECK (confidence >= 0 AND confidence <= 1);
ALTER TABLE events ADD COLUMN last_seen_at timestamptz;
ALTER TABLE events ADD COLUMN last_verified_at timestamptz;
ALTER TABLE events ADD COLUMN last_changed_at timestamptz;

-- ---- occurrences ------------------------------------------------------------
-- door_time and a public lifecycle status distinct from the internal publish
-- status ('draft/published/hidden/cancelled'), so ingestion can express
-- sold-out/postponed/rescheduled/uncertain without touching publish gating.
ALTER TABLE occurrences ADD COLUMN door_time timestamptz;
ALTER TABLE occurrences ADD COLUMN sold_out boolean NOT NULL DEFAULT false;
ALTER TABLE occurrences ADD COLUMN lifecycle_status text NOT NULL DEFAULT 'active'
  CHECK (lifecycle_status IN ('active','sold_out','cancelled','postponed','rescheduled','completed','uncertain'));
