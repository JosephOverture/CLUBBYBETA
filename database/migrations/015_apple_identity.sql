CREATE TABLE apple_login_challenges (
 id uuid PRIMARY KEY,channel text NOT NULL CHECK(channel IN ('web','ios')),verifier_hash text NOT NULL,state_hash text NOT NULL,nonce text NOT NULL,
 link_user_id uuid REFERENCES users(id),expires_at timestamptz NOT NULL,used_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_apple_identity_per_user ON external_identities(user_id) WHERE issuer='https://appleid.apple.com';
CREATE TABLE apple_identity_grants (
 user_id uuid NOT NULL REFERENCES users(id),client_id text NOT NULL,subject text NOT NULL,refresh_encrypted text,
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','revoking','revoked')),version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,client_id)
);
