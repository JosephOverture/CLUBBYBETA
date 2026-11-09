CREATE TABLE ticket_transfers (
 id uuid PRIMARY KEY, ticket_id uuid NOT NULL REFERENCES tickets(id),
 sender_id uuid NOT NULL REFERENCES users(id), recipient_email_hash text NOT NULL,
 recipient_email_encrypted text NOT NULL, token_hash text NOT NULL UNIQUE, token_encrypted text NOT NULL,
 credential_version integer NOT NULL, status text NOT NULL DEFAULT 'pending'
 CHECK(status IN ('pending','accepted','revoked','expired')),
 recipient_id uuid REFERENCES users(id), accepted_at timestamptz, expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((status='accepted')=(accepted_at IS NOT NULL AND recipient_id IS NOT NULL))
);
CREATE UNIQUE INDEX ticket_transfer_pending ON ticket_transfers(ticket_id) WHERE status='pending';
CREATE INDEX ticket_transfer_recipient ON ticket_transfers(recipient_email_hash,created_at DESC);
CREATE INDEX ticket_owner_list ON tickets(owner_id,id);
