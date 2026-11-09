ALTER TABLE destinations ADD COLUMN native_sales_enabled boolean NOT NULL DEFAULT false;
CREATE TABLE destination_aliases(alias text PRIMARY KEY,destination_id text NOT NULL REFERENCES destinations(id));
ALTER TABLE venues ADD COLUMN latitude double precision CHECK(latitude BETWEEN -90 AND 90);
ALTER TABLE venues ADD COLUMN longitude double precision CHECK(longitude BETWEEN -180 AND 180);
ALTER TABLE venues ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE venues ADD COLUMN minimum_age integer NOT NULL DEFAULT 18 CHECK(minimum_age BETWEEN 0 AND 99);
ALTER TABLE venues ADD COLUMN address text NOT NULL DEFAULT '';
ALTER TABLE venues ADD COLUMN contact_url text;
ALTER TABLE venues ADD COLUMN schedule jsonb NOT NULL DEFAULT '{"weekly":[],"exceptions":[]}';
CREATE INDEX venues_coordinates ON venues(latitude,longitude) WHERE status='published';
CREATE INDEX venues_search ON venues USING gin(to_tsvector('simple',name || ' ' || description));
CREATE INDEX venues_tags ON venues USING gin(tags);
CREATE TABLE catalogue_revisions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, resource_type text NOT NULL,resource_id text NOT NULL,
  version integer NOT NULL,actor_id uuid NOT NULL REFERENCES users(id),snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(resource_type,resource_id,version)
);
CREATE TRIGGER catalogue_revisions_immutable BEFORE UPDATE OR DELETE ON catalogue_revisions FOR EACH ROW EXECUTE FUNCTION audit_append_only();
CREATE TABLE venue_claims (
  id uuid PRIMARY KEY,venue_id text NOT NULL REFERENCES venues(id),organization_id uuid NOT NULL REFERENCES organizations(id),
  applicant_id uuid NOT NULL REFERENCES users(id),evidence text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),reviewed_at timestamptz
);
CREATE UNIQUE INDEX venue_claim_pending ON venue_claims(venue_id,organization_id) WHERE status='pending';
CREATE TABLE events (
  id uuid PRIMARY KEY,venue_id text NOT NULL REFERENCES venues(id),organization_id uuid NOT NULL REFERENCES organizations(id),
  title text NOT NULL,description text NOT NULL DEFAULT '',lineup text[] NOT NULL DEFAULT '{}',tags text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','hidden','cancelled')),
  external_url text,version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE occurrences (
  id uuid PRIMARY KEY,event_id uuid NOT NULL REFERENCES events(id),starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL,
  timezone text NOT NULL,currency char(3) NOT NULL,capacity integer NOT NULL CHECK(capacity BETWEEN 0 AND 1000000),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','hidden','cancelled')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),CHECK(ends_at>starts_at)
);
CREATE INDEX occurrences_upcoming ON occurrences(starts_at,event_id) WHERE status='published';
CREATE TABLE event_proposals (
  id uuid PRIMARY KEY,venue_id text NOT NULL REFERENCES venues(id),organization_id uuid NOT NULL REFERENCES organizations(id),
  author_id uuid NOT NULL REFERENCES users(id),payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','changes-requested','approved','rejected')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),event_id uuid UNIQUE REFERENCES events(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE proposal_reviews (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,proposal_id uuid NOT NULL REFERENCES event_proposals(id),
  actor_id uuid NOT NULL REFERENCES users(id),decision text NOT NULL,comment text NOT NULL,
  payload jsonb NOT NULL,version integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER proposal_reviews_immutable BEFORE UPDATE OR DELETE ON proposal_reviews FOR EACH ROW EXECUTE FUNCTION audit_append_only();
CREATE TABLE saved_venues(user_id uuid NOT NULL REFERENCES users(id),venue_id text NOT NULL REFERENCES venues(id),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,venue_id));
CREATE TABLE editorial_placements(venue_id text PRIMARY KEY REFERENCES venues(id),rank integer NOT NULL CHECK(rank>=0),starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL,CHECK(ends_at>starts_at));
CREATE TABLE media_assets (
  id uuid PRIMARY KEY,venue_id text NOT NULL REFERENCES venues(id),event_id uuid REFERENCES events(id),actor_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','ready','rejected','deleted')),
  content_type text NOT NULL CHECK(content_type IN ('image/jpeg','image/png','image/webp')),
  max_bytes integer NOT NULL CHECK(max_bytes BETWEEN 1 AND 5242880),alt_text text NOT NULL,
  original_hash char(64),version integer NOT NULL DEFAULT 1,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '1 hour',created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE venues ADD COLUMN hero_media_id uuid REFERENCES media_assets(id);
ALTER TABLE events ADD COLUMN hero_media_id uuid REFERENCES media_assets(id);
CREATE TABLE public_settings(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),banner text NOT NULL DEFAULT '',new_sales_paused boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1 CHECK(version>0));
INSERT INTO public_settings(singleton) VALUES(true);
CREATE TABLE catalogue_changes (
  id uuid PRIMARY KEY,aggregate_id uuid NOT NULL,kind text NOT NULL,
  payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),processed_at timestamptz
);
