CREATE TABLE platform_environment (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  environment text NOT NULL CHECK (environment IN ('development','test','staging','production')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE destinations (
  id text PRIMARY KEY, name text NOT NULL, country_code char(2) NOT NULL,
  timezone text NOT NULL, currency char(3) NOT NULL,
  published boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE TABLE venues (
  id text PRIMARY KEY, destination_id text NOT NULL REFERENCES destinations(id),
  name text NOT NULL, description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','hidden')),
  commercial_mode text NOT NULL DEFAULT 'external' CHECK (commercial_mode IN ('native','external')),
  external_url text, demo boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX venues_public_destination ON venues(destination_id, id) WHERE status = 'published';

CREATE TABLE outbox_jobs (
  id uuid PRIMARY KEY, topic text NOT NULL, dedupe_key text NOT NULL,
  payload jsonb NOT NULL, payload_hash char(64) NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','done','dead')),
  available_at timestamptz NOT NULL DEFAULT now(), attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 20),
  lease_token uuid, lease_until timestamptz, error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  UNIQUE(topic, dedupe_key),
  CHECK ((status = 'processing') = (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX outbox_due ON outbox_jobs(available_at, id) WHERE status IN ('queued','processing');
CREATE TABLE job_receipts (
  job_id uuid PRIMARY KEY REFERENCES outbox_jobs(id), handler text NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform_probe_results (
  job_id uuid PRIMARY KEY REFERENCES outbox_jobs(id), value jsonb NOT NULL
);
CREATE TABLE worker_heartbeats (id uuid PRIMARY KEY, seen_at timestamptz NOT NULL DEFAULT now());
