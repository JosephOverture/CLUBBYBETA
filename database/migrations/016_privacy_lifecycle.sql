ALTER TABLE privacy_requests ADD COLUMN receipt_hash text;
ALTER TABLE privacy_requests ADD COLUMN receipt_encrypted text;
ALTER TABLE privacy_requests ADD COLUMN due_at timestamptz NOT NULL DEFAULT (now()+interval '30 days');
ALTER TABLE privacy_requests ADD COLUMN expires_at timestamptz;
ALTER TABLE privacy_requests ADD COLUMN error_code text;
ALTER TABLE privacy_requests ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE organizations ADD COLUMN privacy_sales_paused boolean NOT NULL DEFAULT false;
CREATE TABLE privacy_holds (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),
 scope text NOT NULL CHECK(scope IN ('profile','support','chat')),
 legal_basis text NOT NULL,reference text NOT NULL,expires_at timestamptz NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 released_at timestamptz,released_by uuid REFERENCES users(id),
 retained_encrypted text,erased_at timestamptz,
 CHECK(expires_at>created_at)
);
CREATE INDEX privacy_holds_subject ON privacy_holds(user_id) WHERE released_at IS NULL;
CREATE INDEX privacy_operations_queue ON privacy_requests(status,due_at);
-- Serialize new personal writes with account deletion, including requests authenticated
-- just before the account was disabled. Financial updates still settle after deletion.
CREATE FUNCTION require_active_personal_subject() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subject uuid;
BEGIN
 subject := (to_jsonb(NEW)->>TG_ARGV[0])::uuid;
 PERFORM id FROM users WHERE id=subject AND status='active' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Personal account is unavailable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER privacy_new_session BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION require_active_personal_subject('user_id');
CREATE TRIGGER privacy_new_customer BEFORE INSERT ON payment_customers FOR EACH ROW EXECUTE FUNCTION require_active_personal_subject('user_id');
CREATE TRIGGER privacy_new_order BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION require_active_personal_subject('user_id');
CREATE TRIGGER privacy_new_saved_venue BEFORE INSERT ON saved_venues FOR EACH ROW EXECUTE FUNCTION require_active_personal_subject('user_id');
CREATE TRIGGER privacy_new_preferences BEFORE INSERT OR UPDATE ON user_preferences FOR EACH ROW EXECUTE FUNCTION require_active_personal_subject('user_id');
CREATE TRIGGER privacy_new_chat BEFORE INSERT ON group_messages FOR EACH ROW EXECUTE FUNCTION require_active_personal_subject('author_id');
CREATE TRIGGER privacy_new_support BEFORE INSERT ON support_messages FOR EACH ROW EXECUTE FUNCTION require_active_personal_subject('actor_id');
CREATE TRIGGER privacy_new_media BEFORE INSERT ON media_assets FOR EACH ROW EXECUTE FUNCTION require_active_personal_subject('actor_id');
CREATE FUNCTION protect_deleted_profile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status IN ('deletion-pending','deleted') AND NEW.status NOT IN ('deletion-pending','deleted') THEN RAISE EXCEPTION 'Deleted accounts cannot be reactivated'; END IF;
 IF NEW.status='deleted' AND (NEW.email IS NOT NULL OR NEW.email_verified_at IS NOT NULL OR NEW.display_name<>'') THEN RAISE EXCEPTION 'Deleted profiles cannot retain personal data'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER privacy_profile_guard BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION protect_deleted_profile();
