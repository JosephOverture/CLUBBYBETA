ALTER TABLE orders ADD COLUMN payment_role text NOT NULL DEFAULT 'purchase' CHECK(payment_role IN ('purchase','group-reservation','group-contribution'));
CREATE TABLE booking_groups (
 id uuid PRIMARY KEY,order_id uuid NOT NULL UNIQUE REFERENCES orders(id),reservation_id uuid NOT NULL UNIQUE REFERENCES table_reservations(id),
 owner_id uuid NOT NULL REFERENCES users(id),name text NOT NULL,deadline timestamptz NOT NULL,target_minor integer NOT NULL CHECK(target_minor>0),
 guests integer NOT NULL CHECK(guests BETWEEN 1 AND 50),currency text NOT NULL,terms text NOT NULL,
 state text NOT NULL DEFAULT 'funding' CHECK(state IN ('funding','confirmed','cancelling','cancelled','expired','review')),
 cancellation_reason text,cancellation_kind text CHECK(cancellation_kind IN ('cancelled','expired')),
 version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),confirmed_at timestamptz,
 checked_at timestamptz NOT NULL DEFAULT now(),reminded_at timestamptz
);
CREATE TABLE group_members (
 group_id uuid NOT NULL REFERENCES booking_groups(id),user_id uuid NOT NULL REFERENCES users(id),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','left','removed')),
 accepted_terms_at timestamptz NOT NULL DEFAULT now(),joined_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(group_id,user_id)
);
CREATE TABLE group_invitations (
 id uuid PRIMARY KEY,group_id uuid NOT NULL REFERENCES booking_groups(id),inviter_id uuid NOT NULL REFERENCES users(id),
 email_hash text NOT NULL,token_hash text NOT NULL UNIQUE,expires_at timestamptz NOT NULL,used_at timestamptz,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE group_contributions (
 id uuid PRIMARY KEY,group_id uuid NOT NULL REFERENCES booking_groups(id),user_id uuid NOT NULL REFERENCES users(id),
 order_id uuid NOT NULL UNIQUE REFERENCES orders(id),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX group_contributions_group ON group_contributions(group_id,order_id);
CREATE TRIGGER group_contributions_immutable BEFORE UPDATE OR DELETE ON group_contributions FOR EACH ROW EXECUTE FUNCTION audit_append_only();
CREATE TABLE group_ticket_assignments(group_id uuid NOT NULL REFERENCES booking_groups(id),user_id uuid NOT NULL REFERENCES users(id),ticket_id uuid NOT NULL UNIQUE REFERENCES tickets(id),PRIMARY KEY(group_id,user_id));
CREATE TABLE group_owner_transfers (
 id uuid PRIMARY KEY,group_id uuid NOT NULL REFERENCES booking_groups(id),from_user_id uuid NOT NULL REFERENCES users(id),to_user_id uuid NOT NULL REFERENCES users(id),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','revoked')),expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),accepted_at timestamptz
);
CREATE UNIQUE INDEX one_pending_group_owner ON group_owner_transfers(group_id) WHERE status='pending';
CREATE TABLE group_events (
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,group_id uuid NOT NULL REFERENCES booking_groups(id),kind text NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX group_events_cursor ON group_events(group_id,sequence);
CREATE TABLE group_messages (
 id uuid PRIMARY KEY,sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,group_id uuid NOT NULL REFERENCES booking_groups(id),
 author_id uuid NOT NULL REFERENCES users(id),body text NOT NULL CHECK(length(body)<=2000),
 status text NOT NULL DEFAULT 'visible' CHECK(status IN ('visible','hidden','deleted')),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX group_messages_cursor ON group_messages(group_id,sequence);
CREATE TABLE user_blocks (user_id uuid NOT NULL REFERENCES users(id),blocked_user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,blocked_user_id),CHECK(user_id<>blocked_user_id));
CREATE TABLE message_reports (
 id uuid PRIMARY KEY,message_id uuid NOT NULL REFERENCES group_messages(id),reporter_id uuid NOT NULL REFERENCES users(id),reason text NOT NULL,
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),resolution text,resolved_by uuid REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),resolved_at timestamptz,
 UNIQUE(message_id,reporter_id)
);
CREATE INDEX group_deadlines ON booking_groups(deadline) WHERE state IN ('funding','review','cancelling');
CREATE FUNCTION guard_group_contract() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.order_id,NEW.reservation_id,NEW.deadline,NEW.target_minor,NEW.guests,NEW.currency,NEW.terms,NEW.created_at) IS DISTINCT FROM ROW(OLD.order_id,OLD.reservation_id,OLD.deadline,OLD.target_minor,OLD.guests,OLD.currency,OLD.terms,OLD.created_at) THEN RAISE EXCEPTION 'Group funding contracts are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER group_contract_immutable BEFORE UPDATE OR DELETE ON booking_groups FOR EACH ROW EXECUTE FUNCTION guard_group_contract();
