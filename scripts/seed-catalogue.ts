import type { PoolClient } from 'pg';
import venues from '../database/seeds/milan-venues.json' with { type: 'json' };

// Additive and repeatable: existing seller-managed venues are never overwritten.
export async function seedCatalogue(client: PoolClient) {
  await client.query(`INSERT INTO destinations(id,name,country_code,timezone,currency,published)
    VALUES('milan','Milan','IT','Europe/Rome','EUR',true) ON CONFLICT DO NOTHING`);
  await client.query(`INSERT INTO destination_aliases(alias,destination_id)
    SELECT 'milano','milan' WHERE EXISTS(SELECT 1 FROM destinations WHERE id='milan')
      AND NOT EXISTS(SELECT 1 FROM destinations WHERE id='milano') ON CONFLICT DO NOTHING`);
  for (const venue of venues) {
    const details = {
      category: venue.category, neighbourhood: venue.neighbourhood, image: venue.image,
      tagline: venue.tagline, pick: venue.pick, sourceUrl: venue.sourceUrl,
      calendarUrl: 'calendarUrl' in venue ? venue.calendarUrl : null,
      coordinateAccuracy: venue.coordinateAccuracy,
      accessNote: 'accessNote' in venue ? venue.accessNote : null,
      linkType: 'linkType' in venue ? venue.linkType : null,
    };
    await client.query(`INSERT INTO venues(id,destination_id,name,description,status,commercial_mode,demo,
      external_url,latitude,longitude,tags,genres,address,contact_url,last_verified_at,discovery_details)
      VALUES($1,'milan',$2,$3,'published','external',false,$4,$5,$6,$7,$7,$8,$4,$9,$10)
      ON CONFLICT(id) DO UPDATE SET
        name=EXCLUDED.name,description=EXCLUDED.description,commercial_mode=EXCLUDED.commercial_mode,
        demo=false,external_url=EXCLUDED.external_url,latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,
        tags=EXCLUDED.tags,genres=EXCLUDED.genres,address=EXCLUDED.address,contact_url=EXCLUDED.contact_url,
        last_verified_at=EXCLUDED.last_verified_at,discovery_details=EXCLUDED.discovery_details,
        version=venues.version+1,updated_at=now()
      WHERE venues.id='alcatraz' AND venues.demo=true AND venues.version=1
        AND venues.organization_id IS NULL AND venues.name='Alcatraz' AND venues.status='published'
        AND venues.commercial_mode='native' AND venues.external_url IS NULL AND venues.address=''
        AND venues.description='Development fixture; venue details are unverified.'`, [venue.id,venue.name,venue.description,venue.externalUrl,
      venue.latitude,venue.longitude,venue.genres,venue.address,venue.verifiedAt,JSON.stringify(details)]);
  }
}
