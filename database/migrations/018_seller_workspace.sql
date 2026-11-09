ALTER TABLE promotion_codes ADD COLUMN version integer NOT NULL DEFAULT 1;
CREATE INDEX seller_event_listing ON events(organization_id,id);
CREATE INDEX seller_venue_listing ON venues(organization_id,id);
CREATE INDEX seller_proposal_listing ON event_proposals(organization_id,id);
CREATE INDEX host_proposal_listing ON event_proposals(venue_id,id);
ALTER TABLE editorial_placements ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE editorial_placements ADD COLUMN active boolean NOT NULL DEFAULT true;
