-- System B (live-data) ingestion pipeline. Additive only; no changes to existing
-- transactional tables. All data-source provenance lives here, separate from the
-- edit provenance in catalogue_revisions/audit_events.

-- ---- Persistent per-venue and per-event sources -----------------------------
CREATE TABLE venue_sources (
  id uuid PRIMARY KEY,
  venue_id text NOT NULL REFERENCES venues(id),
  source_type text NOT NULL CHECK (source_type IN
    ('official_api','partner_feed','venue_website','venue_event_page','ticketing_provider','official_social','promoter','manual')),
  source_url text NOT NULL,
  provider text,
  priority integer NOT NULL DEFAULT 100,
  refresh_interval_ms bigint NOT NULL DEFAULT 21600000 CHECK (refresh_interval_ms > 0),
  active boolean NOT NULL DEFAULT true,
  content_hash char(64),
  next_check_at timestamptz,
  last_checked_at timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, source_type, source_url)
);
CREATE INDEX venue_sources_due ON venue_sources(next_check_at) WHERE active;

CREATE TABLE event_sources (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES events(id),
  source_type text NOT NULL CHECK (source_type IN
    ('official_api','partner_feed','venue_website','venue_event_page','ticketing_provider','official_social','promoter','manual')),
  source_url text NOT NULL,
  provider text,
  priority integer NOT NULL DEFAULT 100,
  content_hash char(64),
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, source_type, source_url)
);

-- ---- Raw source snapshots (retained for audit; body may live in object store)-
CREATE TABLE raw_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_url text NOT NULL,
  source_type text NOT NULL,
  content_hash char(64) NOT NULL,
  body text,
  storage_ref text,
  fetched_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX raw_snapshots_source ON raw_snapshots(source_url, fetched_at DESC);
CREATE TRIGGER raw_snapshots_immutable BEFORE UPDATE OR DELETE ON raw_snapshots
  FOR EACH ROW EXECUTE FUNCTION audit_append_only();

-- ---- Field-level observations (every sighting, append-only) ------------------
CREATE TABLE venue_observations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  venue_id text NOT NULL REFERENCES venues(id),
  source_id uuid REFERENCES venue_sources(id),
  snapshot_id bigint REFERENCES raw_snapshots(id),
  field text NOT NULL,
  value jsonb,
  confidence numeric CHECK (confidence >= 0 AND confidence <= 1),
  model text,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX venue_observations_lookup ON venue_observations(venue_id, field, observed_at DESC);
CREATE TRIGGER venue_observations_immutable BEFORE UPDATE OR DELETE ON venue_observations
  FOR EACH ROW EXECUTE FUNCTION audit_append_only();

CREATE TABLE event_observations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES events(id),
  source_id uuid REFERENCES event_sources(id),
  snapshot_id bigint REFERENCES raw_snapshots(id),
  field text NOT NULL,
  value jsonb,
  confidence numeric CHECK (confidence >= 0 AND confidence <= 1),
  model text,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_observations_lookup ON event_observations(event_id, field, observed_at DESC);
CREATE TRIGGER event_observations_immutable BEFORE UPDATE OR DELETE ON event_observations
  FOR EACH ROW EXECUTE FUNCTION audit_append_only();

-- ---- Field provenance: which source backs the CURRENT published value --------
CREATE TABLE field_provenance (
  entity_type text NOT NULL CHECK (entity_type IN ('venue','event')),
  entity_id text NOT NULL,
  field text NOT NULL,
  source_id uuid,
  snapshot_id bigint REFERENCES raw_snapshots(id),
  confidence numeric CHECK (confidence >= 0 AND confidence <= 1),
  model text,
  observed_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id, field)
);

-- ---- Structured change history for events -----------------------------------
CREATE TABLE event_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES events(id),
  change_type text NOT NULL,
  changed_fields text[] NOT NULL DEFAULT '{}',
  previous jsonb,
  current jsonb,
  severity text NOT NULL DEFAULT 'low' CHECK (severity IN ('low','medium','high')),
  detected_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_changes_event ON event_changes(event_id, detected_at DESC);
CREATE TRIGGER event_changes_immutable BEFORE UPDATE OR DELETE ON event_changes
  FOR EACH ROW EXECUTE FUNCTION audit_append_only();

-- ---- Ingestion run + failure observability ----------------------------------
CREATE TABLE ingestion_runs (
  id uuid PRIMARY KEY,
  agent text NOT NULL,
  kind text NOT NULL,
  source_id uuid,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','success','error','skipped')),
  items_found integer NOT NULL DEFAULT 0,
  items_changed integer NOT NULL DEFAULT 0,
  provider text,
  model text,
  cost numeric,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  error_message text
);
CREATE INDEX ingestion_runs_recent ON ingestion_runs(started_at DESC);

CREATE TABLE ingestion_failures (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid REFERENCES ingestion_runs(id),
  source_id uuid,
  message text NOT NULL,
  detail jsonb,
  retryable boolean NOT NULL DEFAULT true,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

-- ---- Human review queue (medium/conflicting confidence) ---------------------
CREATE TABLE review_queue (
  id uuid PRIMARY KEY,
  entity_type text NOT NULL CHECK (entity_type IN ('venue','event')),
  entity_id text,
  candidate jsonb NOT NULL,
  reason text NOT NULL,
  confidence numeric CHECK (confidence >= 0 AND confidence <= 1),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by uuid REFERENCES users(id),
  decision_note text
);
CREATE INDEX review_queue_pending ON review_queue(created_at) WHERE status = 'pending';

-- ---- Clubby<->external id mappings for dedup/idempotency --------------------
CREATE TABLE external_entity_mappings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type text NOT NULL CHECK (entity_type IN ('venue','event')),
  entity_id text NOT NULL,
  provider text NOT NULL,
  external_id text NOT NULL,
  source_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id, entity_type)
);
CREATE INDEX external_entity_mappings_entity ON external_entity_mappings(entity_type, entity_id);
