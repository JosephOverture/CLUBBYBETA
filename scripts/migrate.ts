import { resolve } from 'node:path';
import { readConfig } from '../apps/api/src/platform/config';
import { Database } from '../apps/api/src/platform/database';
import { migrate } from '../apps/api/src/platform/migrations';

const db = new Database(readConfig());
try {
  await migrate(db, resolve('database/migrations'));
  if (['staging', 'production'].includes(db.config.APP_ENV)) {
    // The reference deployment separates the migration owner from the runtime login.
    // Future tables use that owner's default privileges; migration metadata stays read-only.
    await db.query(`DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='clubby_app') THEN
        REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON schema_migrations,platform_environment FROM clubby_app;
      END IF;
    END $$`);
  }
  console.log('Database migrations verified.');
} finally {
  await db.onApplicationShutdown();
}
