import { readConfig } from '../apps/api/src/platform/config';
import { Database } from '../apps/api/src/platform/database';
import { seedCatalogue } from './seed-catalogue';

const config = readConfig();
if (!['development', 'test'].includes(config.APP_ENV))
  throw new Error('Demo seed is forbidden outside development/test.');
const db = new Database(config);
try {
  if (!(await db.ready())) throw new Error('Migrate this environment before seeding.');
  await db.transaction(async (client) => {
    await seedCatalogue(client);
  });
  console.log('Milan beta catalogue seeded without overwriting existing venue records.');
} finally {
  await db.onApplicationShutdown();
}
