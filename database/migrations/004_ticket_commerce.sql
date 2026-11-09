CREATE TABLE commercial_policies (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), version integer NOT NULL,
 commission_bps integer NOT NULL CHECK(commission_bps BETWEEN 0 AND 10000),
 refund_cutoff_hours integer NOT NULL CHECK(refund_cutoff_hours BETWEEN 0 AND 8760),
 refund_commission boolean NOT NULL, terms text NOT NULL, tax_registration text NOT NULL,
 processing_fee_bearer text NOT NULL CHECK(processing_fee_bearer='seller'),
 payout_model text NOT NULL CHECK(payout_model='stripe-managed'),
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,version)
);
CREATE TRIGGER commercial_policies_immutable BEFORE UPDATE OR DELETE ON commercial_policies FOR EACH ROW EXECUTE FUNCTION audit_append_only();
CREATE TABLE policy_acceptances (policy_id uuid PRIMARY KEY REFERENCES commercial_policies(id),actor_id uuid NOT NULL REFERENCES users(id),accepted_at timestamptz NOT NULL DEFAULT now());
CREATE TRIGGER policy_acceptances_immutable BEFORE UPDATE OR DELETE ON policy_acceptances FOR EACH ROW EXECUTE FUNCTION audit_append_only();
CREATE TABLE seller_accounts (
 organization_id uuid PRIMARY KEY REFERENCES organizations(id), account_id text UNIQUE,
 creation_key uuid NOT NULL UNIQUE, creation_input jsonb NOT NULL, creation_started_at timestamptz NOT NULL DEFAULT now(),
 charges_enabled boolean NOT NULL DEFAULT false, payouts_enabled boolean NOT NULL DEFAULT false,
 configuration_valid boolean NOT NULL DEFAULT false, livemode boolean NOT NULL DEFAULT false,
 requirements jsonb NOT NULL DEFAULT '{}', synced_at timestamptz,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','restricted','review'))
);
CREATE TABLE ticket_products (
 id uuid PRIMARY KEY, occurrence_id uuid NOT NULL REFERENCES occurrences(id), name text NOT NULL,
 price_minor integer NOT NULL CHECK(price_minor BETWEEN 0 AND 100000000),
 tax_bps integer NOT NULL CHECK(tax_bps BETWEEN 0 AND 10000), tax_inclusive boolean NOT NULL DEFAULT true CHECK(tax_inclusive),
 capacity integer NOT NULL CHECK(capacity BETWEEN 0 AND 1000000), drinks integer NOT NULL DEFAULT 0 CHECK(drinks BETWEEN 0 AND 20),
 sale_starts_at timestamptz NOT NULL, sale_ends_at timestamptz NOT NULL, CHECK(sale_ends_at>sale_starts_at),
 active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ticket_products ADD COLUMN admission_conditions text NOT NULL DEFAULT '';
ALTER TABLE ticket_products ADD COLUMN extra_drink_price_minor integer CHECK(extra_drink_price_minor BETWEEN 0 AND 100000000);
ALTER TABLE ticket_products ADD COLUMN extra_drink_limit integer NOT NULL DEFAULT 0 CHECK(extra_drink_limit BETWEEN 0 AND 10);
ALTER TABLE ticket_products ADD COLUMN extra_drink_tax_bps integer NOT NULL DEFAULT 0 CHECK(extra_drink_tax_bps BETWEEN 0 AND 10000);
ALTER TABLE ticket_products ADD CONSTRAINT extra_drinks_configured CHECK(extra_drink_limit=0 OR extra_drink_price_minor IS NOT NULL);
CREATE TABLE inventory_blocks (id uuid PRIMARY KEY,occurrence_id uuid NOT NULL REFERENCES occurrences(id),quantity integer NOT NULL CHECK(quantity>0),reason text NOT NULL,actor_id uuid NOT NULL REFERENCES users(id),released_at timestamptz,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX ticket_products_occurrence ON ticket_products(occurrence_id,id);
CREATE TABLE promotion_codes (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), occurrence_id uuid REFERENCES occurrences(id),
 code text NOT NULL, discount_bps integer NOT NULL CHECK(discount_bps BETWEEN 1 AND 10000),
 max_uses integer NOT NULL CHECK(max_uses BETWEEN 1 AND 1000000), expires_at timestamptz NOT NULL,
 active boolean NOT NULL DEFAULT true, UNIQUE(organization_id,code)
);
CREATE TABLE orders (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), buyer_email_encrypted text NOT NULL, buyer_email_hash text NOT NULL,
 occurrence_id uuid NOT NULL REFERENCES occurrences(id), venue_id text NOT NULL REFERENCES venues(id),
 organization_id uuid NOT NULL REFERENCES organizations(id), policy_id uuid NOT NULL REFERENCES commercial_policies(id),
 account_id text NOT NULL, currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 total_minor integer NOT NULL CHECK(total_minor BETWEEN 0 AND 100000000), commission_minor integer NOT NULL CHECK(commission_minor BETWEEN 0 AND total_minor),
 discount_minor integer NOT NULL CHECK(discount_minor>=0), tax_minor integer NOT NULL CHECK(tax_minor BETWEEN 0 AND total_minor),
 quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 50), snapshot jsonb NOT NULL,
 status text NOT NULL DEFAULT 'held' CHECK(status IN ('held','payment-pending','paid','cancelled','refund-pending','partially-refunded','refunded','review')),
 expires_at timestamptz NOT NULL, paid_at timestamptz, cancellation_requested boolean NOT NULL DEFAULT false,
 dispute_open boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE orders ADD COLUMN channel text NOT NULL DEFAULT 'web' CHECK(channel IN ('web','ios'));
ALTER TABLE orders ADD COLUMN buyer_accepted_at timestamptz;
CREATE INDEX orders_owner ON orders(user_id,created_at DESC,id);
CREATE INDEX orders_occurrence ON orders(occurrence_id,id);
CREATE INDEX orders_expiration ON orders(expires_at) WHERE status IN ('held','payment-pending');
CREATE TABLE order_lines (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders(id), product_id uuid NOT NULL REFERENCES ticket_products(id),
 quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 8), unit_minor integer NOT NULL CHECK(unit_minor>=0),
 total_minor integer NOT NULL CHECK(total_minor>=0), commission_minor integer NOT NULL CHECK(commission_minor>=0),
 tax_minor integer NOT NULL CHECK(tax_minor>=0), snapshot jsonb NOT NULL, UNIQUE(order_id,product_id)
);
CREATE TABLE inventory_reservations (
 order_id uuid NOT NULL REFERENCES orders(id), product_id uuid NOT NULL REFERENCES ticket_products(id), occurrence_id uuid NOT NULL REFERENCES occurrences(id),
 quantity integer NOT NULL CHECK(quantity>0), status text NOT NULL CHECK(status IN ('held','sold','released')),
 PRIMARY KEY(order_id,product_id)
);
CREATE INDEX inventory_occurrence ON inventory_reservations(occurrence_id,status);
CREATE TABLE promotion_uses (promotion_id uuid NOT NULL REFERENCES promotion_codes(id),order_id uuid PRIMARY KEY REFERENCES orders(id),status text NOT NULL CHECK(status IN ('reserved','used','released')));
CREATE TABLE api_idempotency (
 user_id uuid NOT NULL REFERENCES users(id), operation text NOT NULL, key text NOT NULL, payload_hash text NOT NULL,
 response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,operation,key)
);
CREATE TABLE payment_attempts (
 id uuid PRIMARY KEY, order_id uuid NOT NULL UNIQUE REFERENCES orders(id), account_id text NOT NULL,
 provider_id text, status text NOT NULL DEFAULT 'creating', client_secret_encrypted text,
 created_at timestamptz NOT NULL DEFAULT now(), checked_at timestamptz,
 UNIQUE(account_id,provider_id)
);
CREATE TABLE provider_inbox (
 event_id text PRIMARY KEY, event_type text NOT NULL, account_id text, object_id text, payload_hash text NOT NULL,
 livemode boolean NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz
);
CREATE TABLE tickets (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders(id), line_id uuid NOT NULL REFERENCES order_lines(id),
 occurrence_id uuid NOT NULL REFERENCES occurrences(id), owner_id uuid NOT NULL REFERENCES users(id), ordinal integer NOT NULL,
 credential_hash text NOT NULL UNIQUE, credential_encrypted text NOT NULL, credential_version integer NOT NULL DEFAULT 1,
 amount_minor integer NOT NULL CHECK(amount_minor>=0), commission_minor integer NOT NULL CHECK(commission_minor>=0),
 status text NOT NULL DEFAULT 'valid' CHECK(status IN ('valid','refund-pending','refunded','void')),
 admitted_at timestamptz, drinks_total integer NOT NULL CHECK(drinks_total>=0), drinks_used integer NOT NULL DEFAULT 0 CHECK(drinks_used>=0 AND drinks_used<=drinks_total),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(line_id,ordinal)
);
CREATE INDEX tickets_owner ON tickets(owner_id,created_at DESC,id);
CREATE TABLE admission_scans (
 id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES users(id), ticket_id uuid REFERENCES tickets(id),
 occurrence_id uuid NOT NULL REFERENCES occurrences(id), kind text NOT NULL CHECK(kind IN ('admission','drink')),
 outcome text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER admission_scans_immutable BEFORE UPDATE OR DELETE ON admission_scans FOR EACH ROW EXECUTE FUNCTION audit_append_only();
CREATE TABLE refunds (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders(id), actor_id uuid REFERENCES users(id),
 amount_minor integer NOT NULL CHECK(amount_minor>=0), commission_minor integer NOT NULL CHECK(commission_minor>=0),
 reason text NOT NULL, status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','pending','succeeded','failed','review')),
 provider_id text UNIQUE, fee_provider_id text UNIQUE, fee_started_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE UNIQUE INDEX one_pending_refund ON refunds(order_id) WHERE status IN ('queued','pending','review');
CREATE TABLE refund_tickets (refund_id uuid NOT NULL REFERENCES refunds(id),ticket_id uuid NOT NULL REFERENCES tickets(id),PRIMARY KEY(refund_id,ticket_id));
CREATE TABLE ledger_journals (
 id uuid PRIMARY KEY, reference text NOT NULL UNIQUE, book text NOT NULL CHECK(book IN ('commerce','provider')),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), order_id uuid REFERENCES orders(id), description text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), creation_transaction bigint NOT NULL DEFAULT txid_current()
);
CREATE TABLE ledger_postings (
 id bigserial PRIMARY KEY,journal_id uuid NOT NULL REFERENCES ledger_journals(id),account text NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor<>0)
);
CREATE TRIGGER ledger_journals_immutable BEFORE UPDATE OR DELETE ON ledger_journals FOR EACH ROW EXECUTE FUNCTION audit_append_only();
CREATE TRIGGER ledger_postings_immutable BEFORE UPDATE OR DELETE ON ledger_postings FOR EACH ROW EXECUTE FUNCTION audit_append_only();
CREATE FUNCTION journal_postings_sealed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM ledger_journals WHERE id=NEW.journal_id AND creation_transaction=txid_current()) THEN RAISE EXCEPTION 'Journal is sealed'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ledger_postings_sealed BEFORE INSERT ON ledger_postings FOR EACH ROW EXECUTE FUNCTION journal_postings_sealed();
CREATE FUNCTION check_journal_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE journal uuid; total bigint; entries integer;
BEGIN
 IF TG_TABLE_NAME='ledger_journals' THEN journal:=NEW.id; ELSE journal:=NEW.journal_id; END IF;
 SELECT coalesce(sum(amount_minor),0),count(*) INTO total,entries FROM ledger_postings WHERE journal_id=journal;
 IF total<>0 OR entries<2 THEN RAISE EXCEPTION 'Journal must contain balanced postings'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER ledger_journals_balanced AFTER INSERT ON ledger_journals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_journal_balance();
CREATE CONSTRAINT TRIGGER ledger_postings_balanced AFTER INSERT ON ledger_postings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_journal_balance();
CREATE TABLE provider_balance_transactions (
 account_id text NOT NULL, provider_id text NOT NULL, currency text NOT NULL, amount_minor bigint NOT NULL,
 fee_minor bigint NOT NULL, net_minor bigint NOT NULL, source_id text, kind text NOT NULL, created_at timestamptz NOT NULL,
 available_at timestamptz NOT NULL, PRIMARY KEY(account_id,provider_id), CHECK(amount_minor-fee_minor=net_minor)
);
CREATE TABLE provider_disputes (
 account_id text NOT NULL,provider_id text NOT NULL,order_id uuid REFERENCES orders(id),status text NOT NULL,
 amount_minor bigint NOT NULL,currency text NOT NULL,evidence_due_at timestamptz,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(account_id,provider_id)
);
CREATE TABLE provider_payouts (
 account_id text NOT NULL,provider_id text NOT NULL,status text NOT NULL,amount_minor bigint NOT NULL,currency text NOT NULL,
 arrival_date timestamptz NOT NULL, failure_code text,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(account_id,provider_id)
);
CREATE TABLE reconciliation_runs (id uuid PRIMARY KEY,account_id text NOT NULL,status text NOT NULL,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz);
CREATE TABLE support_cases (
 id uuid PRIMARY KEY,order_id uuid NOT NULL REFERENCES orders(id),user_id uuid NOT NULL REFERENCES users(id),
 subject text NOT NULL,status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','waiting','resolved')),version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE support_messages (id uuid PRIMARY KEY,case_id uuid NOT NULL REFERENCES support_cases(id),actor_id uuid NOT NULL REFERENCES users(id),body text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE external_refunds (provider_id text PRIMARY KEY,order_id uuid NOT NULL REFERENCES orders(id),amount_minor integer NOT NULL,currency text NOT NULL,status text NOT NULL,allocated_refund_id uuid REFERENCES refunds(id),created_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION protect_order_money() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.occurrence_id,NEW.venue_id,NEW.organization_id,NEW.policy_id,NEW.account_id,NEW.currency,NEW.total_minor,NEW.commission_minor,NEW.discount_minor,NEW.tax_minor,NEW.quantity,NEW.snapshot)
 IS DISTINCT FROM ROW(OLD.occurrence_id,OLD.venue_id,OLD.organization_id,OLD.policy_id,OLD.account_id,OLD.currency,OLD.total_minor,OLD.commission_minor,OLD.discount_minor,OLD.tax_minor,OLD.quantity,OLD.snapshot)
 THEN RAISE EXCEPTION 'Purchased financial snapshots are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER orders_money_immutable BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION protect_order_money();
CREATE TRIGGER order_lines_immutable BEFORE UPDATE OR DELETE ON order_lines FOR EACH ROW EXECUTE FUNCTION audit_append_only();
CREATE TRIGGER provider_transactions_immutable BEFORE UPDATE OR DELETE ON provider_balance_transactions FOR EACH ROW EXECUTE FUNCTION audit_append_only();
