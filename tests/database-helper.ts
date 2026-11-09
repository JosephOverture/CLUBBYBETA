import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { readConfig } from '../apps/api/src/platform/config';
import { Database } from '../apps/api/src/platform/database';

export async function isolatedDatabase(environment: Record<string, string | undefined> = {}) {
  if (!process.env.TEST_DATABASE_URL)
    throw new Error('TEST_DATABASE_URL must explicitly designate disposable test infrastructure.');
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  const name = `clubby_test_${randomUUID().replaceAll('-', '')}`;
  if (!/^clubby_test_[a-f0-9]{32}$/.test(name)) throw new Error('Unsafe test database name.');
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const db = new Database(
    readConfig({ ...environment, APP_ENV: 'test', DATABASE_URL: url.href, LOG_LEVEL: 'silent' }),
  );
  return {
    db,
    async dispose() {
      // This exact generated name was created above; never drop the supplied database.
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
    },
  };
}
