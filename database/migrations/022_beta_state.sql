-- The public beta does not require accounts. An opaque browser cookie identifies
-- one private visitor; only its SHA-256 digest is retained in the database.
CREATE TABLE beta_visitors (
  token_hash char(64) PRIMARY KEY,
  profile_name text NOT NULL DEFAULT 'Guest' CHECK (char_length(profile_name) BETWEEN 1 AND 40),
  theme text NOT NULL DEFAULT 'dark' CHECK (theme IN ('dark','light')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '90 days'
);
CREATE INDEX beta_visitors_expiry ON beta_visitors(expires_at);

CREATE TABLE beta_saved_venues (
  visitor_hash char(64) NOT NULL REFERENCES beta_visitors(token_hash) ON DELETE CASCADE,
  venue_id text NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(visitor_hash,venue_id)
);

CREATE TABLE beta_plans (
  id uuid PRIMARY KEY,
  visitor_hash char(64) NOT NULL REFERENCES beta_visitors(token_hash) ON DELETE CASCADE,
  venue_id text NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  note text NOT NULL DEFAULT '' CHECK (char_length(note)<=400),
  plan_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX beta_plans_visitor ON beta_plans(visitor_hash,created_at DESC,id);
