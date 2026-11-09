CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE TABLE physical_tables (id uuid PRIMARY KEY,venue_id text NOT NULL REFERENCES venues(id),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE venue_layouts (
 id uuid PRIMARY KEY,venue_id text NOT NULL REFERENCES venues(id),version integer NOT NULL CHECK(version>0),
 content jsonb NOT NULL,actor_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(venue_id,version)
);
CREATE TRIGGER venue_layouts_immutable BEFORE UPDATE OR DELETE ON venue_layouts FOR EACH ROW EXECUTE FUNCTION audit_append_only();
CREATE TABLE occurrence_layouts (occurrence_id uuid PRIMARY KEY REFERENCES occurrences(id),layout_id uuid NOT NULL REFERENCES venue_layouts(id),version integer NOT NULL DEFAULT 1);
ALTER TABLE ticket_products ADD COLUMN kind text NOT NULL DEFAULT 'ticket' CHECK(kind IN ('ticket','table'));
CREATE TABLE table_offers (
 id uuid PRIMARY KEY,occurrence_id uuid NOT NULL REFERENCES occurrences(id),table_id uuid NOT NULL REFERENCES physical_tables(id),
 layout_id uuid NOT NULL REFERENCES venue_layouts(id),product_id uuid NOT NULL UNIQUE REFERENCES ticket_products(id),
 slot_starts_at timestamptz NOT NULL,slot_ends_at timestamptz NOT NULL,CHECK(slot_ends_at>slot_starts_at),
 min_guests integer NOT NULL CHECK(min_guests BETWEEN 1 AND 50),max_guests integer NOT NULL CHECK(max_guests BETWEEN min_guests AND 50),
 full_price_minor integer NOT NULL CHECK(full_price_minor BETWEEN 1 AND 100000000),
 deposit_minor integer CHECK(deposit_minor BETWEEN 1 AND full_price_minor),
 tax_bps integer NOT NULL CHECK(tax_bps BETWEEN 0 AND 10000),
 inclusions text NOT NULL,minimum_spend_minor integer NOT NULL CHECK(minimum_spend_minor BETWEEN 0 AND full_price_minor),
 terms text NOT NULL,no_show_after_minutes integer NOT NULL CHECK(no_show_after_minutes BETWEEN 0 AND 1440),
 no_show_policy text NOT NULL CHECK(no_show_policy='retain-paid'),active boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1
);
CREATE TABLE table_reservations (
 id uuid PRIMARY KEY,offer_id uuid NOT NULL REFERENCES table_offers(id),order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
 guests integer NOT NULL CHECK(guests BETWEEN 1 AND 50),full_price_minor integer NOT NULL CHECK(full_price_minor>0),
 online_amount_minor integer NOT NULL CHECK(online_amount_minor BETWEEN 1 AND full_price_minor),
 commission_minor integer NOT NULL CHECK(commission_minor BETWEEN 0 AND online_amount_minor),
 currency text NOT NULL,snapshot jsonb NOT NULL,
 status text NOT NULL DEFAULT 'held' CHECK(status IN ('held','confirmed','cancelled','no-show','refund-review')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE table_allocations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),reservation_id uuid UNIQUE REFERENCES table_reservations(id),table_id uuid NOT NULL REFERENCES physical_tables(id),
 block_actor_id uuid REFERENCES users(id),block_reason text,
 CHECK((reservation_id IS NOT NULL AND block_actor_id IS NULL AND block_reason IS NULL) OR (reservation_id IS NULL AND block_actor_id IS NOT NULL AND block_reason IS NOT NULL AND length(block_reason)>=10)),
 slot_starts_at timestamptz NOT NULL,slot_ends_at timestamptz NOT NULL,CHECK(slot_ends_at>slot_starts_at),
 occupied_range tstzrange GENERATED ALWAYS AS (tstzrange(slot_starts_at,slot_ends_at,'[)')) STORED,
 status text NOT NULL DEFAULT 'held' CHECK(status IN ('held','confirmed','released')),
 EXCLUDE USING gist(table_id WITH =,occupied_range WITH &&) WHERE (status IN ('held','confirmed'))
);
ALTER TABLE order_lines ADD COLUMN admission_count integer;
DROP TRIGGER order_lines_immutable ON order_lines;
UPDATE order_lines SET admission_count=quantity;
CREATE TRIGGER order_lines_immutable BEFORE UPDATE OR DELETE ON order_lines FOR EACH ROW EXECUTE FUNCTION audit_append_only();
ALTER TABLE order_lines ALTER COLUMN admission_count SET NOT NULL;
ALTER TABLE order_lines ADD CONSTRAINT positive_line_admissions CHECK(admission_count BETWEEN 1 AND 50);
-- Existing line snapshots are immutable; new rows must supply their exact admission count.
CREATE TABLE door_collections (
 id uuid PRIMARY KEY,reservation_id uuid NOT NULL REFERENCES table_reservations(id),venue_id text NOT NULL REFERENCES venues(id),actor_id uuid NOT NULL REFERENCES users(id),
 amount_minor integer NOT NULL CHECK(amount_minor<>0),method text NOT NULL CHECK(method IN ('cash','external-card')),
 reference text NOT NULL,reason text NOT NULL,reversal_of uuid UNIQUE REFERENCES door_collections(id),
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(venue_id,method,reference),
 CHECK((amount_minor>0 AND reversal_of IS NULL) OR (amount_minor<0 AND reversal_of IS NOT NULL))
);
CREATE TRIGGER door_collections_immutable BEFORE UPDATE OR DELETE ON door_collections FOR EACH ROW EXECUTE FUNCTION audit_append_only();
CREATE FUNCTION guard_table_financials() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') THEN
  RAISE EXCEPTION 'Table reservation financial snapshots are immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER table_reservation_financials BEFORE UPDATE OR DELETE ON table_reservations FOR EACH ROW EXECUTE FUNCTION guard_table_financials();
CREATE FUNCTION guard_table_offer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-'active'-'version') IS DISTINCT FROM (to_jsonb(OLD)-'active'-'version') THEN
  RAISE EXCEPTION 'Table offers are immutable; deactivate and create a replacement';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER table_offer_immutable BEFORE UPDATE OR DELETE ON table_offers FOR EACH ROW EXECUTE FUNCTION guard_table_offer();
CREATE TRIGGER physical_tables_immutable BEFORE UPDATE OR DELETE ON physical_tables FOR EACH ROW EXECUTE FUNCTION audit_append_only();
