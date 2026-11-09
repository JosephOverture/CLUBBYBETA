ALTER TABLE outbox_jobs ADD COLUMN replay_generation integer NOT NULL DEFAULT 0 CHECK(replay_generation>=0);
CREATE INDEX operational_job_listing ON outbox_jobs(status,id);
CREATE INDEX operational_job_age ON outbox_jobs(created_at) WHERE status IN ('queued','processing','dead');
ALTER TABLE worker_heartbeats ADD COLUMN maintenance_at timestamptz;
ALTER TABLE worker_heartbeats ADD COLUMN last_error_at timestamptz;

CREATE TABLE http_rate_windows (
 key_hash text PRIMARY KEY CHECK(length(key_hash)=64),
 hits integer NOT NULL CHECK(hits>0), expires_at timestamptz NOT NULL
);
CREATE INDEX http_rate_expiry ON http_rate_windows(expires_at);
