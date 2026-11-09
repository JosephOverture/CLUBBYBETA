ALTER TABLE support_cases ADD COLUMN ticket_id uuid REFERENCES tickets(id);
ALTER TABLE support_cases ADD COLUMN assigned_to uuid REFERENCES users(id);
ALTER TABLE support_cases ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE support_cases ADD COLUMN resolved_at timestamptz;
UPDATE support_cases SET updated_at=created_at,resolved_at=CASE WHEN status='resolved' THEN created_at END;
ALTER TABLE support_messages ADD COLUMN sequence bigserial UNIQUE;
CREATE INDEX support_messages_cursor ON support_messages(case_id,sequence);
CREATE INDEX support_cases_customer ON support_cases(user_id,id);
CREATE INDEX support_cases_order ON support_cases(order_id,status,id);
