ALTER TABLE users ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE platform_grants ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE public_settings ADD COLUMN features jsonb NOT NULL DEFAULT '{"groupCreation":true,"ticketTransfers":true,"walletCreation":true,"chatMessages":true}';
CREATE TABLE market_reviews (
 id uuid PRIMARY KEY,destination_id text NOT NULL REFERENCES destinations(id),version integer NOT NULL,
 country_code text NOT NULL,currency text NOT NULL,timezone text NOT NULL,seller_countries text[] NOT NULL,
 checks jsonb NOT NULL,evidence text NOT NULL,reviewed_by uuid NOT NULL REFERENCES users(id),reviewed_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,UNIQUE(destination_id,version)
);
CREATE TRIGGER market_review_immutable BEFORE UPDATE OR DELETE ON market_reviews FOR EACH ROW EXECUTE FUNCTION audit_append_only();
ALTER TABLE destinations ADD COLUMN market_review_id uuid REFERENCES market_reviews(id);
-- Existing switches are not evidence of a reviewed market. Activation now requires an explicit review.
UPDATE destinations SET native_sales_enabled=false WHERE native_sales_enabled=true;
CREATE TABLE organization_owner_transfers (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations(id),from_user_id uuid NOT NULL REFERENCES users(id),
 to_user_id uuid NOT NULL REFERENCES users(id),created_by uuid NOT NULL REFERENCES users(id),reason text NOT NULL,
 organization_version integer NOT NULL,policy_id uuid REFERENCES commercial_policies(id),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','accepted','revoked')),expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),accepted_at timestamptz
);
CREATE UNIQUE INDEX owner_transfer_pending ON organization_owner_transfers(organization_id) WHERE state='pending';
