import { z } from 'zod';
import { Database } from '../apps/api/src/platform/database';
import { readConfig } from '../apps/api/src/platform/config';
import { audit } from '../apps/api/src/organizations/organizations.service';

const email = z.string().email().parse(process.argv[2]).toLowerCase();
const reason = z.string().trim().min(10).parse(process.argv[3]);
const db = new Database(readConfig());
try {
  await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(42819209)');
    const existing = await tx.query(
      "SELECT user_id FROM platform_grants WHERE role='admin' AND revoked_at IS NULL",
    );
    if (existing.rowCount)
      throw new Error('An administrator already exists; use the reviewed access-management procedure.');
    const user = await tx.query<{ id: string }>(
      "SELECT id FROM users WHERE email=$1 AND email_verified_at IS NOT NULL AND status='active' AND kind='registered'",
      [email],
    );
    if (!user.rows[0]) throw new Error('The first administrator must sign in and verify their email first.');
    await tx.query("INSERT INTO platform_grants(user_id,role) VALUES($1,'admin')", [user.rows[0].id]);
    await audit(tx, user.rows[0].id, 'platform.bootstrap', 'user', user.rows[0].id, reason);
  });
  console.log('First administrator provisioned and audited.');
} finally {
  await db.onApplicationShutdown();
}
