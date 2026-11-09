import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { setTimeout } from 'node:timers/promises';
import { readConfig } from '../../api/src/platform/config';
import { Database } from '../../api/src/platform/database';
import { JobQueue, platformHandlers } from '../../api/src/platform/jobs';
import { NotificationDelivery } from '../../api/src/notifications/delivery';
import { PrivacyService } from '../../api/src/privacy/privacy.service';
import { MediaService } from '../../api/src/media/media.service';
import { ObjectStore } from '../../api/src/media/object-store';
import { OrganizationsService } from '../../api/src/organizations/organizations.service';
import { commerceServices } from '../../api/src/commerce/services';
import { NotificationsService } from '../../api/src/notifications/notifications.service';
import { EmailFeedbackService } from '../../api/src/notifications/email-feedback';
import { ReportingService } from '../../api/src/reporting/reporting.service';
import { IdentityService } from '../../api/src/identity/identity.service';
import { AppleService } from '../../api/src/identity/apple.service';
import { AppleNotificationsService } from '../../api/src/identity/apple-notifications.service';
import { WorkerHealth } from '../../api/src/platform/worker-health';
import { OperationsService } from '../../api/src/platform/operations.service';

const db = new Database(readConfig());
const delivery = new NotificationDelivery(db, db.config);
const media = new MediaService(db, new OrganizationsService(db, db.config), new ObjectStore(db.config));
const commerce = commerceServices(db, new OrganizationsService(db, db.config));
const notifications = new NotificationsService(db, new OrganizationsService(db, db.config));
const feedback = new EmailFeedbackService(db, new OrganizationsService(db, db.config));
const reporting = new ReportingService(db, new OrganizationsService(db, db.config));
const apple = new AppleService(db, new IdentityService(db, db.config));
const privacy = new PrivacyService(db, db.config, {
  erasePayments: (id) => commerce.savedMethods.eraseUser(id),
  revokeApple: (id) => apple.revokeUser(id),
  eraseMedia: (assetId) => media.cleanup({ assetId }),
  eraseLocalMail: (id) => delivery.eraseLocalUser(id),
});
const queue = new JobQueue(
  db,
  {
    ...platformHandlers,
    'catalogue.changed': commerce.payments.catalogueChanged,
    'privacy.process': privacy.handler,
    'notification.publish': notifications.publish,
  },
  {
    ...commerce.payments.externalHandlers(),
    'privacy.erase': (payload) =>
      privacy.erase(z.object({ requestId: z.string().uuid() }).parse(payload).requestId),
    'report.generate': (payload) =>
      reporting.generate(z.object({ reportId: z.string().uuid() }).parse(payload).reportId),
    'notification.push': (payload) =>
      notifications.sendPush(z.object({ pushId: z.string().uuid() }).parse(payload).pushId),
    'wallet.sync': (payload) =>
      commerce.wallet.sync(z.object({ passId: z.string().uuid() }).parse(payload).passId),
    'group.reconcile': (payload) =>
      commerce.groups.reconcile(z.object({ groupId: z.string().uuid() }).parse(payload).groupId),
    'notification.deliver': (payload, id) => delivery.send(payload, id),
    'media.process': (payload) => media.process(payload),
    'media.cleanup': (payload) => media.cleanup(payload),
  },
);
const workerId = randomUUID();
const health = new WorkerHealth(db, workerId);
const operations = new OperationsService(db, new OrganizationsService(db, db.config));
let stopping = false;
let lastMaintenance = 0;
process.on('SIGTERM', () => {
  stopping = true;
  health.stop();
});
process.on('SIGINT', () => {
  stopping = true;
  health.stop();
});
try {
  if (!(await db.ready())) throw new Error('Database is not ready.');
  await health.start(db.config.WORKER_HEALTH_PORT, db.config.HOST);
  while (!stopping) {
    try {
      if (Date.now() - lastMaintenance > 60_000) {
        await media.expireUploads();
        await commerce.payments.maintenance();
        await commerce.groups.maintenance();
        await commerce.wallet.maintenance();
        await feedback.maintenance();
        await reporting.maintenance();
        await apple.maintenance();
        await new AppleNotificationsService(db, privacy).maintenance();
        await privacy.maintenance();
        await notifications.reminders();
        await db.query("DELETE FROM worker_heartbeats WHERE seen_at<clock_timestamp()-interval '7 days'");
        await db.query('DELETE FROM http_rate_windows WHERE expires_at<clock_timestamp()');
        await health.maintained();
        process.stdout.write(
          JSON.stringify({
            event: 'operations.snapshot',
            environment: db.config.APP_ENV,
            ...(await operations.snapshot()),
          }) + '\n',
        );
        lastMaintenance = Date.now();
      }
      if (!(await queue.tick())) await setTimeout(1000);
    } catch {
      await health.failed().catch(() => {});
      process.stderr.write('{"event":"worker.iteration-failed"}\n');
      await setTimeout(2000);
    }
  }
} finally {
  await health.close();
  await db.onApplicationShutdown();
}
