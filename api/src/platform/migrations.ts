import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database } from './database';

export async function migrate(db: Database, directory: string) {
  const files = (await readdir(directory)).filter((f) => /^\d+_[a-z0-9_]+\.sql$/.test(f)).sort();
  if (!files.length) throw new Error('No migrations found.');
  const client = await db.pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(42819207)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY, checksum char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = await client.query<{ filename: string; checksum: string }>(
      'SELECT filename, checksum FROM schema_migrations ORDER BY filename',
    );
    const existing = await client.query<{ exists: string | null }>(
      "SELECT to_regclass('public.platform_environment') AS exists",
    );
    if (existing.rows[0]?.exists) {
      const owner = await client.query<{ environment: string }>(
        'SELECT environment FROM platform_environment',
      );
      if (owner.rows[0]?.environment !== db.config.APP_ENV)
        throw new Error('Database belongs to a different environment.');
    }
    for (const row of applied.rows)
      if (!files.includes(row.filename)) throw new Error(`Missing applied migration: ${row.filename}`);
    for (const filename of files) {
      const sql = await readFile(join(directory, filename), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = applied.rows.find((r) => r.filename === filename);
      if (previous) {
        if (previous.checksum !== checksum) throw new Error(`Changed applied migration: ${filename}`);
        continue;
      }
      if (applied.rows.some((r) => r.filename > filename))
        throw new Error(`Out-of-order migration: ${filename}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        if (filename === '001_platform.sql') {
          await client.query('INSERT INTO platform_environment(singleton,environment) VALUES(true,$1)', [
            db.config.APP_ENV,
          ]);
        }
        await client.query('INSERT INTO schema_migrations(filename, checksum) VALUES ($1,$2)', [
          filename,
          checksum,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    await client.query(
      'INSERT INTO platform_environment(singleton, environment) VALUES (true,$1) ON CONFLICT DO NOTHING',
      [db.config.APP_ENV],
    );
    const environment = await client.query<{ environment: string }>(
      'SELECT environment FROM platform_environment',
    );
    if (environment.rows[0]?.environment !== db.config.APP_ENV)
      throw new Error('Database belongs to a different environment.');
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(42819207)');
    } finally {
      client.release();
    }
  }
}
