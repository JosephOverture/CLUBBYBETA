CREATE SEQUENCE wallet_revision;
CREATE TABLE wallet_passes (
 id uuid PRIMARY KEY, ticket_id uuid NOT NULL REFERENCES tickets(id), owner_id uuid NOT NULL REFERENCES users(id),
 credential_version integer NOT NULL, auth_hash text NOT NULL, auth_encrypted text NOT NULL,
 apple_requested boolean NOT NULL DEFAULT false, google_requested boolean NOT NULL DEFAULT false,
 revision bigint NOT NULL DEFAULT nextval('wallet_revision'), updated_at timestamptz NOT NULL DEFAULT now(),
 apple_notified_revision bigint NOT NULL DEFAULT 0, google_synced_revision bigint NOT NULL DEFAULT 0,
 checked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(ticket_id,credential_version)
);
CREATE TABLE wallet_registrations (
 device_hash text NOT NULL, pass_id uuid NOT NULL REFERENCES wallet_passes(id),
 push_encrypted text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(device_hash,pass_id)
);
CREATE TABLE wallet_downloads (
 token_hash text PRIMARY KEY, pass_id uuid NOT NULL REFERENCES wallet_passes(id), session_id uuid NOT NULL REFERENCES sessions(id),
 expires_at timestamptz NOT NULL, used_at timestamptz
);
CREATE FUNCTION wallet_mark_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='tickets' THEN
   UPDATE wallet_passes SET revision=nextval('wallet_revision'),updated_at=clock_timestamp() WHERE ticket_id=NEW.id;
 ELSIF TG_TABLE_NAME='orders' THEN
   UPDATE wallet_passes SET revision=nextval('wallet_revision'),updated_at=clock_timestamp() WHERE ticket_id IN(SELECT id FROM tickets WHERE order_id=NEW.id);
 ELSIF TG_TABLE_NAME='occurrences' THEN
   UPDATE wallet_passes SET revision=nextval('wallet_revision'),updated_at=clock_timestamp() WHERE ticket_id IN(SELECT id FROM tickets WHERE occurrence_id=NEW.id);
 ELSIF TG_TABLE_NAME='table_reservations' THEN
   UPDATE wallet_passes SET revision=nextval('wallet_revision'),updated_at=clock_timestamp() WHERE ticket_id IN(SELECT id FROM tickets WHERE order_id=NEW.order_id);
 ELSIF TG_TABLE_NAME='door_collections' THEN
   UPDATE wallet_passes SET revision=nextval('wallet_revision'),updated_at=clock_timestamp() WHERE ticket_id IN(SELECT t.id FROM tickets t JOIN table_reservations r ON r.order_id=t.order_id WHERE r.id=NEW.reservation_id);
 ELSIF TG_TABLE_NAME='users' THEN
   UPDATE wallet_passes SET revision=nextval('wallet_revision'),updated_at=clock_timestamp() WHERE owner_id=NEW.id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER wallet_ticket_changed AFTER UPDATE OF owner_id,credential_version,status,admitted_at,drinks_used ON tickets FOR EACH ROW EXECUTE FUNCTION wallet_mark_changed();
CREATE TRIGGER wallet_order_changed AFTER UPDATE OF status,dispute_open,cancellation_requested ON orders FOR EACH ROW EXECUTE FUNCTION wallet_mark_changed();
CREATE TRIGGER wallet_occurrence_changed AFTER UPDATE OF starts_at,ends_at,status ON occurrences FOR EACH ROW EXECUTE FUNCTION wallet_mark_changed();
CREATE TRIGGER wallet_table_changed AFTER UPDATE OF status ON table_reservations FOR EACH ROW EXECUTE FUNCTION wallet_mark_changed();
CREATE TRIGGER wallet_door_changed AFTER INSERT ON door_collections FOR EACH ROW EXECUTE FUNCTION wallet_mark_changed();
CREATE TRIGGER wallet_user_changed AFTER UPDATE OF status ON users FOR EACH ROW EXECUTE FUNCTION wallet_mark_changed();
