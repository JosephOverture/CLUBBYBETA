-- Presentation metadata from the recovered public beta. Inventory and commerce
-- continue to use the existing canonical venue columns.
ALTER TABLE venues ADD COLUMN discovery_details jsonb NOT NULL DEFAULT '{}'
  CHECK (jsonb_typeof(discovery_details) = 'object');
