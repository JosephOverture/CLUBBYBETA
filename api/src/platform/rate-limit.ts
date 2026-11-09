import type { Database } from './database';
import { hash } from './crypto';

/** Shared fixed windows: every replica consumes the same budget. No raw IP is stored. */
export function rateStore(db: Database) {
  return class PostgresRateStore {
    incr(
      key: string,
      callback: (error: Error | null, result?: { current: number; ttl: number }) => void,
      window: number,
      max: number,
    ) {
      void db
        .query<{ current: number; ttl: number }>(
          `
        INSERT INTO http_rate_windows(key_hash,hits,expires_at)
        VALUES($1,1,clock_timestamp()+$2::int*interval '1 millisecond')
        ON CONFLICT(key_hash) DO UPDATE SET
          hits=CASE WHEN http_rate_windows.expires_at<=clock_timestamp() THEN 1 ELSE LEAST(http_rate_windows.hits+1,$3::int+1) END,
          expires_at=CASE WHEN http_rate_windows.expires_at<=clock_timestamp() THEN clock_timestamp()+$2::int*interval '1 millisecond' ELSE http_rate_windows.expires_at END
        RETURNING hits AS current,GREATEST(0,ceil(extract(epoch FROM expires_at-clock_timestamp())*1000))::int AS ttl`,
          [hash(key), window, max],
        )
        .then((result) => callback(null, result.rows[0]))
        .catch(() => callback(new Error('Rate limit store unavailable.')));
    }
    child() {
      return new PostgresRateStore();
    }
  };
}
