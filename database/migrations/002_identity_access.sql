CREATE TABLE users (
  id uuid PRIMARY KEY, email text UNIQUE, email_verified_at timestamptz,
  display_name text NOT NULL DEFAULT '', kind text NOT NULL CHECK (kind IN ('guest','registered')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deletion-pending','deleted')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (email IS NULL OR email=lower(email)),
  CHECK (kind='guest' OR (email IS NOT NULL AND email_verified_at IS NOT NULL) OR status='deleted')
);
CREATE TABLE login_challenges (
  id uuid PRIMARY KEY, email text NOT NULL, token_hash char(64) NOT NULL,
  verifier_hash text NOT NULL, channel text NOT NULL CHECK (channel IN ('web','ios')),
  expires_at timestamptz NOT NULL, used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_challenges_rate ON login_challenges(email,created_at);
CREATE TABLE sessions (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
  token_hash char(64) UNIQUE NOT NULL, csrf_hash char(64) NOT NULL,
  channel text NOT NULL CHECK (channel IN ('web','ios')), expires_at timestamptz NOT NULL,
  revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE refresh_tokens (
  token_hash char(64) PRIMARY KEY, session_id uuid NOT NULL REFERENCES sessions(id),
  expires_at timestamptz NOT NULL, used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE external_identities (
  issuer text NOT NULL, subject text NOT NULL, user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(issuer,subject)
);
CREATE TABLE oidc_challenges (
  id uuid PRIMARY KEY, nonce text NOT NULL, verifier_hash text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('web','ios')), expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE TABLE notification_deliveries (
  id uuid PRIMARY KEY, user_id uuid REFERENCES users(id), recipient_hash char(64), kind text NOT NULL,
  encrypted_payload text NOT NULL, status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','sent','failed','suppressed')),
  provider_reference text, created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz
);
CREATE TABLE organizations (
  id uuid PRIMARY KEY, name text NOT NULL, country_code char(2) NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','suspended')),
  application jsonb NOT NULL DEFAULT '{}', version integer NOT NULL DEFAULT 1 CHECK(version>0),
  provider_account_id text UNIQUE, provider_charges_enabled boolean NOT NULL DEFAULT false,
  provider_payouts_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE venues ADD COLUMN organization_id uuid REFERENCES organizations(id);
CREATE TABLE memberships (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK(role IN ('owner','manager','editor','door','finance')),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
  venue_ids text[], created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,user_id)
);
CREATE TABLE staff_invitations (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), email text NOT NULL,
  role text NOT NULL CHECK(role IN ('manager','editor','door','finance')),
  venue_ids text[], token_hash char(64) UNIQUE NOT NULL, inviter_id uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL, accepted_at timestamptz, revoked_at timestamptz
);
CREATE TABLE platform_grants (
  user_id uuid NOT NULL REFERENCES users(id), role text NOT NULL CHECK(role IN ('admin','support','finance')),
  revoked_at timestamptz, PRIMARY KEY(user_id,role)
);
CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id uuid REFERENCES users(id), action text NOT NULL, resource_type text NOT NULL, resource_id text NOT NULL,
  reason text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit records are append-only'; END $$;
CREATE TRIGGER audit_no_update_delete BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_append_only();
CREATE TABLE privacy_requests (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), kind text NOT NULL CHECK(kind IN ('export','delete')),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','review-required')),
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, result_encrypted text
);
CREATE UNIQUE INDEX privacy_one_pending ON privacy_requests(user_id,kind) WHERE status IN ('pending','processing','review-required');
