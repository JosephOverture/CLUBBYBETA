import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { Config } from './config';
import { readFileSync } from 'node:fs';

export function connectionOptions(config: Config) {
  const url = new URL(config.DATABASE_URL);
  if (url.searchParams.get('sslmode') !== 'verify-full') return { connectionString: config.DATABASE_URL };
  // pg replaces explicit SSL settings if SSL query parameters remain in the URL.
  for (const field of ['sslmode', 'ssl', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat'])
    url.searchParams.delete(field);
  return {
    connectionString: url.toString(),
    ssl: {
      rejectUnauthorized: true,
      ...(config.DATABASE_CA_PATH ? { ca: readFileSync(config.DATABASE_CA_PATH, 'utf8') } : {}),
    },
  };
}

export class Database {
  readonly pool: Pool;
  constructor(readonly config: Config) {
    this.pool = new Pool({
      ...connectionOptions(config),
      max: 12,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 10_000,
      application_name: 'clubby',
    });
    // Never allow an idle client error to terminate the process or leak connection details.
    this.pool.on('error', () => process.stderr.write('Database connection interrupted.\n'));
  }
  query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) {
    return this.pool.query<T>(sql, params);
  }
  async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '15s'");
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* Preserve the original failure. */
      }
      throw error;
    } finally {
      client.release();
    }
  }
  async ready() {
    try {
      const result = await this.query<{ environment: string }>(
        'SELECT environment FROM platform_environment WHERE singleton = true',
      );
      if (result.rows[0]?.environment !== this.config.APP_ENV) return false;
      const directory = resolve('database/migrations');
      const expected = (await readdir(directory)).filter((f) => /^\d+_[a-z0-9_]+\.sql$/.test(f));
      const applied = await this.query<{ filename: string; checksum: string }>(
        'SELECT filename,checksum FROM schema_migrations',
      );
      // Additive migrations may be applied while the preceding compatible artifact drains.
      // Every migration known to this artifact must still match; rollback never runs old migrations.
      if (!expected.length || expected.length > applied.rows.length) return false;
      for (const file of expected) {
        const checksum = createHash('sha256')
          .update(await readFile(resolve(directory, file)))
          .digest('hex');
        if (!applied.rows.some((r) => r.filename === file && r.checksum === checksum)) return false;
      }
      return true;
    } catch {
      return false;
    }
  }
  async onApplicationShutdown() {
    await this.pool.end();
  }
}
