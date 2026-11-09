CREATE TABLE payment_customers (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), account_id text NOT NULL,
 provider_id text, status text NOT NULL DEFAULT 'creating' CHECK(status IN ('creating','ready','review','deleting','deleted')),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,account_id), UNIQUE(account_id,provider_id)
);
ALTER TABLE payment_attempts ADD COLUMN customer_id text;
ALTER TABLE payment_attempts ADD COLUMN save_card boolean NOT NULL DEFAULT false;
ALTER TABLE payment_attempts ADD COLUMN card_consent_at timestamptz;
ALTER TABLE payment_attempts ADD COLUMN card_save_status text NOT NULL DEFAULT 'not-requested' CHECK(card_save_status IN ('not-requested','pending','saved','removed','review'));
ALTER TABLE payment_attempts ADD CONSTRAINT payment_card_consent CHECK((NOT save_card AND card_consent_at IS NULL) OR (save_card AND customer_id IS NOT NULL AND card_consent_at IS NOT NULL));
CREATE FUNCTION protect_payment_customer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.customer_id,NEW.save_card,NEW.card_consent_at) IS DISTINCT FROM ROW(OLD.customer_id,OLD.save_card,OLD.card_consent_at)
 THEN RAISE EXCEPTION 'Payment customer and consent are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER payment_customer_immutable BEFORE UPDATE ON payment_attempts FOR EACH ROW EXECUTE FUNCTION protect_payment_customer();
CREATE TABLE saved_method_removals (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), customer_id uuid NOT NULL REFERENCES payment_customers(id),
 method_id text NOT NULL, status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','completed')),
 created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, UNIQUE(customer_id,method_id)
);
