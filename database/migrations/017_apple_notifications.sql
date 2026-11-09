ALTER TABLE apple_identity_grants ADD COLUMN authenticated_at timestamptz NOT NULL DEFAULT now();
UPDATE apple_identity_grants SET authenticated_at=date_trunc('second',created_at);
CREATE TABLE apple_notification_inbox (
 id text PRIMARY KEY,payload_hash text NOT NULL,event_type text NOT NULL,
 subject_hash text NOT NULL,occurred_at timestamptz NOT NULL,received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE apple_revocations (
 subject_hash text PRIMARY KEY,revoked_at timestamptz NOT NULL,received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE apple_email_preferences (
 user_id uuid PRIMARY KEY REFERENCES users(id),recipient_hash text NOT NULL,
 disabled boolean NOT NULL,changed_at timestamptz NOT NULL
);
