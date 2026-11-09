import { AdministrationService } from '../apps/api/src/administration/administration.service';
import type { Database } from '../apps/api/src/platform/database';
import type { Principal } from '../apps/api/src/identity/identity.service';
import type { SellersService } from '../apps/api/src/commerce/sellers.service';
export async function activateTestMarket(
  db: Database,
  admin: Principal,
  sellers: SellersService,
  id = 'milan',
) {
  if (db.config.APP_ENV !== 'test') throw new Error('Market fixtures require an isolated test environment.');
  const destination = (await db.query('SELECT version FROM destinations WHERE id=$1', [id])).rows[0]!;
  const result = await new AdministrationService(db, sellers.organizations).reviewMarket(admin, id, {
    expectedVersion: destination.version,
    sellerCountries: ['IT'],
    checks: {
      catalogueReviewed: true,
      providerSupported: true,
      refundAndTaxTermsReviewed: true,
      payoutsReviewed: true,
      localSupportReady: true,
      privacyReviewed: true,
    },
    evidence:
      'Isolated automated test fixture with a simulated provider. This is not production market approval.',
    expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
    reason: 'Configure explicit isolated test market evidence',
  });
  await sellers.market(admin, id, {
    enabled: true,
    expectedVersion: result.data.version,
    reason: 'Activate the isolated test market with configured seller fixture',
  });
}
