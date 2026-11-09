import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import type { Config } from '../platform/config';
import { Database } from '../platform/database';
import { decrypt, hash } from '../platform/crypto';
import { NotificationsService } from './notifications.service';
import { EmailFeedbackService } from './email-feedback';
import { OrganizationsService } from '../organizations/organizations.service';

const messageSchema = z.object({
  to: z.string().email(),
  subject: z.string().max(300),
  text: z.string().max(20_000),
});
export class NotificationDelivery {
  constructor(
    private readonly db: Database,
    private readonly config: Config,
    private readonly transport: typeof fetch = fetch,
    private readonly directory = resolve('.local-data/mail'),
  ) {}
  async send(payload: unknown, jobId: string) {
    const { deliveryId } = z.object({ deliveryId: z.string().uuid() }).parse(payload);
    const result = await this.db.query<{ encrypted_payload: string; status: string; created_at: Date }>(
      'SELECT encrypted_payload,status,created_at FROM notification_deliveries WHERE id=$1',
      [deliveryId],
    );
    const row = result.rows[0];
    if (!row || row.status === 'sent' || row.status === 'suppressed') return;
    const organizations = new OrganizationsService(this.db, this.config);
    if (!(await new NotificationsService(this.db, organizations).mayEmail(deliveryId))) {
      await this.db.query(
        "UPDATE notification_deliveries SET status='suppressed',delivery_state='suppressed' WHERE id=$1 AND status NOT IN ('sent','suppressed')",
        [deliveryId],
      );
      return;
    }
    if (this.config.EMAIL_MODE === 'disabled') throw new Error('Email delivery is disabled.');
    const message = messageSchema.parse(decrypt(row.encrypted_payload, this.config.encryptionKeys));
    let reference: string;
    if (this.config.EMAIL_MODE === 'file') {
      if (!['development', 'test'].includes(this.config.APP_ENV))
        throw new Error('Development delivery is forbidden.');
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const filename = join(this.directory, `${deliveryId}.json`);
      const contents = JSON.stringify(message, null, 2);
      try {
        await writeFile(filename, contents, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
        if ((await readFile(filename, 'utf8')) !== contents)
          throw new Error('Delivery idempotency conflict.');
      }
      reference = `local:${deliveryId}`;
      if (!(await new NotificationsService(this.db, organizations).mayEmail(deliveryId))) {
        await unlink(filename).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
        return;
      }
    } else {
      // Resend's idempotency window is 24 hours. Stop for review instead of risking a duplicate beyond it.
      if (Date.now() - row.created_at.getTime() > 23 * 3600_000) {
        await this.db.query(
          "UPDATE notification_deliveries SET status='failed',delivery_state='failed' WHERE id=$1",
          [deliveryId],
        );
        throw new Error('Provider idempotency window expired; review required.');
      }
      const response = await this.transport('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.RESEND_API_KEY}`,
          'content-type': 'application/json',
          'idempotency-key': jobId,
        },
        body: JSON.stringify({ ...message, from: this.config.EMAIL_FROM }),
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error('Email provider did not accept delivery.');
      reference = z.object({ id: z.string() }).parse(await response.json()).id;
    }
    await this.db.query(
      "UPDATE notification_deliveries SET status='sent',delivery_state='accepted',provider_reference=$1,sent_at=now() WHERE id=$2",
      [reference, deliveryId],
    );
    await new EmailFeedbackService(this.db, organizations).apply(reference);
  }
  async eraseLocalUser(userId: string) {
    if (this.config.EMAIL_MODE !== 'file') return;
    const user = (await this.db.query('SELECT email FROM users WHERE id=$1', [userId])).rows[0];
    const rows = (
      await this.db.query('SELECT id FROM notification_deliveries WHERE user_id=$1 OR recipient_hash=$2', [
        userId,
        hash(user?.email ?? `deleted:${userId}`),
      ])
    ).rows;
    for (const row of rows)
      await unlink(join(this.directory, `${z.string().uuid().parse(row.id)}.json`)).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
  }
}
