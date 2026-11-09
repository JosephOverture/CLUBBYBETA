CREATE TABLE report_exports (
 id uuid PRIMARY KEY,requested_by uuid NOT NULL REFERENCES users(id),organization_id uuid REFERENCES organizations(id),
 filters jsonb NOT NULL,venue_ids text[],status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','completed','denied','expired','failed')),error_code text,
 result_encrypted text,created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days'
);
CREATE INDEX reports_owner ON report_exports(requested_by,created_at DESC);
CREATE INDEX orders_reporting ON orders(organization_id,paid_at) WHERE paid_at IS NOT NULL;
CREATE INDEX journals_reporting ON ledger_journals(created_at,order_id);
CREATE INDEX scans_reporting ON admission_scans(occurrence_id,created_at);
