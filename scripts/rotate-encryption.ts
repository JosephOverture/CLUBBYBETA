import { Database } from '../apps/api/src/platform/database';
import { readConfig } from '../apps/api/src/platform/config';
import { rotateEncryption } from '../apps/api/src/platform/encryption-rotation';
if (process.env.ROTATION_MAINTENANCE_ACK !== 'services-drained-and-backup-verified')
  throw new Error('Drain API/workers and verify a backup before the maintenance rewrap.');
const db = new Database(readConfig());
try {
  if (!(await db.ready())) throw new Error('Database is not ready.');
  const live = await db.query(
    "SELECT 1 FROM worker_heartbeats WHERE seen_at>clock_timestamp()-interval '90 seconds' LIMIT 1",
  );
  if (live.rowCount) throw new Error('Workers must be stopped before encryption maintenance.');
  console.log(JSON.stringify({ event: 'encryption.rotation-complete', ...(await rotateEncryption(db)) }));
} finally {
  await db.onApplicationShutdown();
}
