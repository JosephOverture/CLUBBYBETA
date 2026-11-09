CREATE TABLE user_preferences (
 user_id uuid PRIMARY KEY REFERENCES users(id), locale text NOT NULL DEFAULT 'en', timezone text NOT NULL DEFAULT 'Europe/Rome',
 destination_id text REFERENCES destinations(id), booking_email boolean NOT NULL DEFAULT true,
 marketing_email boolean NOT NULL DEFAULT false, booking_push boolean NOT NULL DEFAULT true,
 marketing_push boolean NOT NULL DEFAULT false, chat_push boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE notification_deliveries ADD COLUMN category text NOT NULL DEFAULT 'transactional' CHECK(category IN ('security','transactional','collaboration','marketing'));
ALTER TABLE notification_deliveries ADD COLUMN target jsonb;
ALTER TABLE notification_deliveries ADD COLUMN dedupe_key text;
ALTER TABLE notification_deliveries ADD COLUMN delivery_state text NOT NULL DEFAULT 'queued' CHECK(delivery_state IN ('queued','accepted','delivered','delayed','bounced','complained','failed','suppressed'));
UPDATE notification_deliveries d SET dedupe_key=j.dedupe_key FROM outbox_jobs j WHERE j.topic='notification.deliver' AND j.payload->>'deliveryId'=d.id::text;
UPDATE notification_deliveries SET dedupe_key=id::text WHERE dedupe_key IS NULL;
ALTER TABLE notification_deliveries ADD CONSTRAINT notification_dedupe UNIQUE(dedupe_key);
UPDATE notification_deliveries SET category='security' WHERE kind='sign-in';
UPDATE notification_deliveries SET delivery_state=CASE WHEN status='sent' THEN 'accepted' ELSE status END;
CREATE TABLE inapp_notifications (
 delivery_id uuid PRIMARY KEY REFERENCES notification_deliveries(id), sequence bigserial UNIQUE,
 read_at timestamptz, hidden_at timestamptz
);
INSERT INTO inapp_notifications(delivery_id) SELECT id FROM notification_deliveries WHERE category<>'security' AND kind NOT LIKE 'marketing-%' AND created_at>now()-interval '90 days' ORDER BY created_at,id;
CREATE INDEX notification_owner_created ON notification_deliveries(user_id,created_at DESC,id);
CREATE INDEX notification_provider_reference ON notification_deliveries(provider_reference) WHERE provider_reference IS NOT NULL;
CREATE TABLE email_feedback (
 id text PRIMARY KEY, provider_reference text NOT NULL, event_type text NOT NULL,
 occurred_at timestamptz NOT NULL, payload_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), checked_at timestamptz, applied_at timestamptz
);
CREATE INDEX email_feedback_reference ON email_feedback(provider_reference);
CREATE TABLE email_suppressions (
 recipient_hash text PRIMARY KEY, reason text NOT NULL CHECK(reason IN ('bounced','complained')),
 feedback_id text NOT NULL REFERENCES email_feedback(id), created_at timestamptz NOT NULL DEFAULT now(),
 released_at timestamptz, released_by uuid REFERENCES users(id), release_reason text
);
CREATE TABLE push_devices (
 id uuid PRIMARY KEY, installation_id uuid NOT NULL UNIQUE, user_id uuid NOT NULL REFERENCES users(id), session_id uuid NOT NULL REFERENCES sessions(id),
 token_hash text NOT NULL, token_encrypted text NOT NULL, environment text NOT NULL CHECK(environment IN ('sandbox','production')),
 generation integer NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
 updated_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX push_device_token ON push_devices(token_hash) WHERE status='active';
CREATE TABLE push_deliveries (
 id uuid PRIMARY KEY, delivery_id uuid NOT NULL REFERENCES notification_deliveries(id), device_id uuid NOT NULL REFERENCES push_devices(id),
 generation integer NOT NULL, status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sent','suppressed','unregistered')),
 created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz, UNIQUE(delivery_id,device_id,generation)
);
CREATE INDEX push_devices_user_session ON push_devices(user_id,session_id) WHERE status='active';
CREATE FUNCTION classify_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.dedupe_key:=coalesce(NEW.dedupe_key,NEW.id::text);
 IF NEW.kind='sign-in' THEN NEW.category:='security';
 ELSIF NEW.kind='group-message' THEN NEW.category:='collaboration';
 ELSIF NEW.kind LIKE 'marketing-%' THEN NEW.category:='marketing'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER notification_classification BEFORE INSERT ON notification_deliveries FOR EACH ROW EXECUTE FUNCTION classify_notification();
CREATE FUNCTION publish_notification() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE body text;
BEGIN
 body:='{"deliveryId":"'||NEW.id::text||'"}';
 INSERT INTO outbox_jobs(id,topic,dedupe_key,payload,payload_hash) VALUES(gen_random_uuid(),'notification.publish',NEW.id::text,body::jsonb,encode(sha256(convert_to(body,'UTF8')),'hex'));
 RETURN NEW;
END $$;
CREATE TRIGGER notification_publish AFTER INSERT ON notification_deliveries FOR EACH ROW EXECUTE FUNCTION publish_notification();
CREATE FUNCTION revoke_push_sessions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.revoked_at IS NOT NULL THEN
   UPDATE push_devices SET status='revoked',generation=generation+1,updated_at=clock_timestamp() WHERE session_id=NEW.id AND status='active';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER push_session_revocation AFTER UPDATE OF revoked_at ON sessions FOR EACH ROW EXECUTE FUNCTION revoke_push_sessions();
