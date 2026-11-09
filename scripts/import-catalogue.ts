import { readConfig } from '../apps/api/src/platform/config';
import { Database } from '../apps/api/src/platform/database';
import { seedCatalogue } from './seed-catalogue';

// Explicit deployment step for the real editorial directory, separate from demo
// commerce data. Existing venue records are preserved by the additive importer.
const db = new Database(readConfig());
try {
  if (!(await db.ready())) throw new Error('Migrate this environment before importing the catalogue.');
  await db.transaction(seedCatalogue);
  console.log('Editorial catalogue imported; existing seller records preserved.');
} finally {
  await db.onApplicationShutdown();
}
