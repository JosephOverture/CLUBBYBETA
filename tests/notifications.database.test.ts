import { randomUUID, randomBytes } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { Webhook } from 'svix';
import { commerceFixture } from './commerce-fixture';
import { NotificationsService } from '../apps/api/src/notifications/notifications.service';
import { EmailFeedbackService } from '../apps/api/src/notifications/email-feedback';
import { NotificationDelivery } from '../apps/api/src/notifications/delivery';
import { OrganizationsService } from '../apps/api/src/organizations/organizations.service';
import { IdentityService } from '../apps/api/src/identity/identity.service';
import { GroupsService } from '../apps/api/src/groups/groups.service';
import { ChatService } from '../apps/api/src/groups/chat.service';
import { OrdersService } from '../apps/api/src/commerce/orders.service';
import { InventoryService } from '../apps/api/src/commerce/inventory.service';
import { TransfersService } from '../apps/api/src/tickets/transfers.service';
import { notifyBuyer } from '../apps/api/src/commerce/core';
import { hash } from '../apps/api/src/platform/crypto';
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'notification preferences, recipient isolation and provider feedback',
  () => {
    let f: Awaited<ReturnType<typeof commerceFixture>>,
      notifications: NotificationsService,
      feedback: EmailFeedbackService;
    const secret = `whsec_${randomBytes(32).toString('base64')}`;
    const push = {
      send: vi.fn(
        async (_token: string, _notification: string, _id: string): Promise<'sent' | 'unregistered'> =>
          'sent',
      ),
    };
    beforeAll(async () => {
      f = await commerceFixture({
        RESEND_WEBHOOK_SECRETS: secret,
        APPLE_PUSH_ENABLED: 'true',
        APPLE_TEAM_ID: 'TESTTEAM01',
        APPLE_PUSH_KEY_ID: 'TESTKEY001',
        APPLE_PUSH_KEY_PATH: 'test-not-read.p8',
        APPLE_PUSH_BUNDLE_ID: 'com.clubby.test',
      });
      notifications = new NotificationsService(f.db, f.app.get(OrganizationsService), push);
      feedback = f.app.get(EmailFeedbackService);
    });
    afterAll(async () => {
      if (f) await f.close();
    });
    async function message(
      user: Awaited<ReturnType<typeof f.actor>>,
      kind = 'booking-confirmed',
      key = randomUUID(),
      senderId = user.principal.userId,
    ) {
      await f.db.transaction((tx) =>
        notifyBuyer(
          tx,
          f.db.config,
          senderId,
          user.email,
          kind,
          'Clubby update',
          'Open Clubby for details.',
          key,
        ),
      );
      return (await f.db.query('SELECT * FROM notification_deliveries WHERE dedupe_key=$1', [key])).rows[0]!;
    }
    async function publish(id: string) {
      await f.db.transaction((tx) => notifications.publish(tx, { deliveryId: id }, randomUUID()));
    }
    function signed(
      reference: string,
      type: string,
      id = randomUUID(),
      eventDate = new Date(),
      signingDate = new Date(),
    ) {
      const body = JSON.stringify({
        type,
        created_at: eventDate.toISOString(),
        data: { email_id: reference },
      });
      return {
        body: Buffer.from(body),
        headers: {
          'svix-id': id,
          'svix-timestamp': String(Math.floor(signingDate.getTime() / 1000)),
          'svix-signature': new Webhook(secret).sign(id, signingDate, body),
        },
      };
    }
    async function event(reference: string, type: string, date?: Date) {
      const v = signed(reference, type, randomUUID(), date);
      return feedback.webhook(v.body, v.headers);
    }
    async function preferences(user: Awaited<ReturnType<typeof f.actor>>, changes: Record<string, unknown>) {
      const { version, pushAvailable, ...value } = (await notifications.preferences(user.principal)).data;
      return notifications.updatePreferences(user.principal, {
        ...value,
        ...changes,
        expectedVersion: version,
      });
    }
    async function device(
      user: Awaited<ReturnType<typeof f.actor>>,
      installationId = randomUUID(),
      token = randomBytes(32).toString('hex'),
    ) {
      return notifications.register(user.principal, { installationId, token, environment: 'sandbox' });
    }
    it('atomically deduplicates recipient-owned notifications and excludes security codes from inboxes', async () => {
      const recipient = await f.actor(),
        sender = await f.actor(),
        key = randomUUID();
      const rows = await Promise.all([
        message(recipient, 'group-invitation', key, sender.principal.userId),
        message(recipient, 'group-invitation', key, sender.principal.userId),
      ]);
      expect(rows[0]!.id).toBe(rows[1].id);
      expect(rows[0].user_id).toBe(recipient.principal.userId);
      const jobs = (
        await f.db.query("SELECT topic FROM outbox_jobs WHERE payload->>'deliveryId'=$1 ORDER BY topic", [
          rows[0]!.id,
        ])
      ).rows;
      expect(jobs.map((j) => j.topic)).toEqual(['notification.deliver', 'notification.publish']);
      await publish(rows[0]!.id);
      await publish(rows[0]!.id);
      expect((await notifications.inbox(recipient.principal)).data).toHaveLength(1);
      expect((await notifications.inbox(sender.principal)).data).toHaveLength(0);
      await expect(notifications.detail(sender.principal, rows[0]!.id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(notifications.read(sender.principal, rows[0]!.id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await notifications.read(recipient.principal, rows[0]!.id);
      expect((await notifications.detail(recipient.principal, rows[0]!.id)).data.readAt).toBeTruthy();
      const security = await message(recipient, 'sign-in');
      await publish(security.id);
      expect((await notifications.inbox(recipient.principal)).data).toHaveLength(1);
    });
    it('requires versioned explicit marketing consent, respects booking preferences and retains security email', async () => {
      const user = await f.actor(),
        initial = (await notifications.preferences(user.principal)).data;
      expect(initial.marketingEmail).toBe(false);
      expect(initial.marketingPush).toBe(false);
      const marketing = await message(user, 'marketing-event');
      await publish(marketing.id);
      expect(await notifications.mayEmail(marketing.id)).toBe(false);
      expect((await notifications.inbox(user.principal)).data).toHaveLength(0);
      const { version, pushAvailable, ...input } = initial;
      const results = await Promise.allSettled([
        notifications.updatePreferences(user.principal, {
          ...input,
          expectedVersion: 0,
          bookingEmail: false,
        }),
        notifications.updatePreferences(user.principal, {
          ...input,
          expectedVersion: 0,
          bookingEmail: false,
        }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const booking = await message(user),
        security = await message(user, 'sign-in');
      expect(await notifications.mayEmail(booking.id)).toBe(false);
      expect(await notifications.mayEmail(security.id)).toBe(true);
      const transport = vi.fn();
      await new NotificationDelivery(f.db, f.db.config, transport).send(
        { deliveryId: booking.id },
        randomUUID(),
      );
      expect(transport).not.toHaveBeenCalled();
      expect(
        (await f.db.query('SELECT status FROM notification_deliveries WHERE id=$1', [booking.id])).rows[0]!
          .status,
      ).toBe('suppressed');
      await preferences(user, { marketingEmail: true });
      await publish(marketing.id);
      expect(await notifications.mayEmail(marketing.id)).toBe(true);
      expect((await notifications.inbox(user.principal)).data).toHaveLength(1);
      expect(
        (
          await f.db.query("SELECT id FROM audit_events WHERE actor_id=$1 AND action='preferences.update'", [
            user.principal.userId,
          ])
        ).rowCount,
      ).toBe(2);
    });
    it('verifies signed raw email feedback, rejects replay mutations, and reconciles early/out-of-order receipts', async () => {
      const user = await f.actor(),
        row = await message(user),
        ref = randomUUID(),
        first = signed(ref, 'email.delivered');
      await expect(
        feedback.webhook(first.body, { ...first.headers, 'svix-signature': 'v1,invalid' }),
      ).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
      const stale = signed(ref, 'email.sent', randomUUID(), new Date(), new Date(Date.now() - 600_000));
      await expect(feedback.webhook(stale.body, stale.headers)).rejects.toMatchObject({
        code: 'INVALID_SIGNATURE',
      });
      const response = await f.app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: 'POST',
          url: '/v1/webhooks/resend',
          headers: { ...first.headers, 'content-type': 'application/json' },
          payload: first.body,
        });
      expect(response.statusCode).toBe(201);
      await feedback.webhook(first.body, first.headers);
      const conflict = signed(ref, 'email.bounced', first.headers['svix-id']);
      await expect(feedback.webhook(conflict.body, conflict.headers)).rejects.toMatchObject({
        code: 'WEBHOOK_CONFLICT',
      });
      await f.db.query("UPDATE notification_deliveries SET status='sent',provider_reference=$1 WHERE id=$2", [
        ref,
        row.id,
      ]);
      await feedback.maintenance();
      await event(ref, 'email.delivery_delayed');
      await event(ref, 'email.sent');
      expect(
        (await f.db.query('SELECT delivery_state FROM notification_deliveries WHERE id=$1', [row.id]))
          .rows[0]!.delivery_state,
      ).toBe('delivered');
      expect(
        (await f.db.query('SELECT * FROM email_feedback WHERE id=$1', [first.headers['svix-id']])).rows[0]!
          .applied_at,
      ).toBeTruthy();
    });
    it('suppresses complained recipients, limits staff visibility and requires an audited release without stale re-suppression', async () => {
      const user = await f.actor(),
        row = await message(user),
        ref = randomUUID();
      await f.db.query("UPDATE notification_deliveries SET status='sent',provider_reference=$1 WHERE id=$2", [
        ref,
        row.id,
      ]);
      await event(ref, 'email.complained', new Date(Date.now() - 60_000));
      const security = await message(user, 'sign-in');
      expect(await notifications.mayEmail(security.id)).toBe(false);
      await expect(feedback.support(f.owner.principal, user.principal.userId)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      const visible = (await feedback.support(f.admin.principal, user.principal.userId)).data;
      expect(visible.find((d) => d.id === row.id)!.deliveryState).toBe('complained');
      expect(JSON.stringify(visible)).not.toContain(user.email);
      await expect(
        feedback.release(user.principal, {
          userId: user.principal.userId,
          reason: 'Verified mailbox and account holder consent',
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await feedback.release(f.admin.principal, {
        userId: user.principal.userId,
        reason: 'Verified mailbox and account holder consent',
      });
      await feedback.apply(ref);
      expect(await notifications.mayEmail(security.id)).toBe(true);
      const older = await message(user),
        other = randomUUID();
      await f.db.query('UPDATE notification_deliveries SET provider_reference=$1 WHERE id=$2', [
        other,
        older.id,
      ]);
      await event(other, 'email.bounced', new Date(Date.now() - 120_000));
      expect(await notifications.mayEmail(security.id)).toBe(true);
      await event(other, 'email.complained', new Date(Date.now() + 1000));
      expect(await notifications.mayEmail(security.id)).toBe(false);
      expect(
        (
          await f.db.query('SELECT reason FROM email_suppressions WHERE recipient_hash=$1', [
            hash(user.email),
          ])
        ).rows[0]!.reason,
      ).toBe('complained');
    });
    it('fences push against logout and shared-device account changes and only sends notification IDs', async () => {
      const user = await f.actor(),
        next = await f.actor(),
        installationId = randomUUID(),
        token = randomBytes(32).toString('hex');
      await device(user, installationId, token);
      const row = await message(user);
      await publish(row.id);
      const id = (await f.db.query('SELECT id FROM push_deliveries WHERE delivery_id=$1', [row.id])).rows[0]!
        .id;
      push.send.mockClear();
      await device(next, installationId, token);
      await notifications.sendPush(id);
      expect(push.send).not.toHaveBeenCalled();
      const later = await message(next);
      await publish(later.id);
      const p = (await f.db.query('SELECT id FROM push_deliveries WHERE delivery_id=$1', [later.id])).rows[0]!
        .id;
      await notifications.sendPush(p);
      await notifications.sendPush(p);
      expect(push.send).toHaveBeenCalledExactlyOnceWith(token, later.id, p);
      const queued = await message(next);
      await publish(queued.id);
      await f.app.get(IdentityService).logout(next.principal);
      await notifications.sendPush(
        (await f.db.query('SELECT id FROM push_deliveries WHERE delivery_id=$1', [queued.id])).rows[0]!.id,
      );
      expect(push.send).toHaveBeenCalledTimes(1);
      expect((await notifications.devices(next.principal)).data).toHaveLength(0);
      const web = await f.actor('web');
      await expect(device(web)).rejects.toMatchObject({ code: 'PUSH_UNAVAILABLE' });
    });
    it('revokes invalid APNs tokens and leaves transient failures retryable', async () => {
      const user = await f.actor();
      await device(user);
      const row = await message(user);
      await publish(row.id);
      const id = (await f.db.query('SELECT id FROM push_deliveries WHERE delivery_id=$1', [row.id])).rows[0]!
        .id;
      push.send.mockRejectedValueOnce(new Error('APNs unavailable'));
      await expect(notifications.sendPush(id)).rejects.toThrow('APNs unavailable');
      expect((await f.db.query('SELECT status FROM push_deliveries WHERE id=$1', [id])).rows[0]!.status).toBe(
        'queued',
      );
      push.send.mockResolvedValueOnce('unregistered');
      await notifications.sendPush(id);
      expect((await notifications.devices(user.principal)).data).toHaveLength(0);
    });
    it('binds invitations to recipients, excludes blocked chat alerts and prevents pushes after group departure', async () => {
      const owner = await f.actor(),
        member = await f.actor(),
        offer = await f.offer(),
        groups = f.app.get(GroupsService),
        chat = f.app.get(ChatService);
      const group = await groups.create(
        owner.principal,
        {
          name: 'Notification group',
          offerId: offer.offerId,
          expectedVersion: 1,
          guests: 4,
          paymentMode: 'deposit',
          deadline: new Date(Date.now() + 600_000).toISOString(),
          acceptTerms: true,
          acceptBalanceResponsibility: true,
        },
        randomUUID(),
      );
      const invite = await groups.invite(owner.principal, group.data.id, { email: member.email });
      const row = (
        await f.db.query('SELECT * FROM notification_deliveries WHERE dedupe_key=$1', [
          `group-invite:${invite.data.id}`,
        ])
      ).rows[0]!;
      expect(row.user_id).toBe(member.principal.userId);
      await groups.accept(member.principal, invite.data.token);
      await device(member);
      await chat.block(member.principal, owner.principal.userId, true);
      await expect(
        groups.invite(owner.principal, group.data.id, { email: member.email }),
      ).rejects.toMatchObject({ code: 'INVITATION_UNAVAILABLE' });
      await chat.send(owner.principal, group.data.id, { body: 'A private message' }, randomUUID());
      expect(
        (
          await f.db.query(
            "SELECT id FROM notification_deliveries WHERE user_id=$1 AND kind='group-message'",
            [member.principal.userId],
          )
        ).rowCount,
      ).toBe(0);
      await chat.block(member.principal, owner.principal.userId, false);
      await chat.send(owner.principal, group.data.id, { body: 'Another private message' }, randomUUID());
      const chatRow = (
        await f.db.query("SELECT * FROM notification_deliveries WHERE user_id=$1 AND kind='group-message'", [
          member.principal.userId,
        ])
      ).rows[0]!;
      await publish(chatRow.id);
      expect(await notifications.mayEmail(chatRow.id)).toBe(false);
      expect(JSON.stringify((await notifications.detail(member.principal, chatRow.id)).data)).not.toContain(
        'private message',
      );
      await f.db.query("UPDATE group_members SET status='left' WHERE user_id=$1 AND group_id=$2", [
        member.principal.userId,
        group.data.id,
      ]);
      push.send.mockClear();
      await notifications.sendPush(
        (await f.db.query('SELECT id FROM push_deliveries WHERE delivery_id=$1', [chatRow.id])).rows[0]!.id,
      );
      expect(push.send).not.toHaveBeenCalled();
    });
    it('deduplicates timezone-correct reminders, targets transferred holders and suppresses cancelled visits', async () => {
      const buyer = await f.actor(),
        receiver = await f.actor(),
        offer = await f.offer(),
        orders = f.app.get(OrdersService);
      const product = await f.app
        .get(InventoryService)
        .product(f.owner.principal, offer.occurrenceId, {
          name: 'Reminder entry',
          priceMinor: 1000,
          taxBps: 0,
          capacity: 20,
          drinks: 0,
          saleStartsAt: new Date(Date.now() - 60_000).toISOString(),
          saleEndsAt: offer.ends.toISOString(),
          active: true,
        });
      const order = await orders.hold(
        buyer.principal,
        {
          occurrenceId: offer.occurrenceId,
          email: buyer.email,
          items: [{ productId: product.data.id, quantity: 1 }],
        },
        randomUUID(),
      );
      const payment = await orders.startPayment(buyer.principal, order.data.id, true);
      await orders.applyPayment(f.provider.sellerValue.id, f.provider.succeed(payment.data.paymentIntentId));
      const ticket = (await f.db.query('SELECT id FROM tickets WHERE order_id=$1', [order.data.id])).rows[0]!;
      const transfers = f.app.get(TransfersService),
        invitation = await transfers.create(
          buyer.principal,
          ticket.id,
          { email: receiver.email },
          randomUUID(),
        );
      // The invitation secret is intentionally absent from API idempotency records; retrieve the encrypted mail as a test recipient.
      const { decrypt } = await import('../apps/api/src/platform/crypto');
      const mail = (
        await f.db.query('SELECT encrypted_payload FROM notification_deliveries WHERE dedupe_key=$1', [
          `transfer-invite:${invitation.data.id}`,
        ])
      ).rows[0]!;
      const text = (decrypt(mail.encrypted_payload, f.db.config.APP_ENCRYPTION_KEY) as { text: string }).text;
      await transfers.invitation(
        receiver.principal,
        { token: text.match(/Invitation code: ([A-Za-z0-9_-]+)/)![1], acceptTerms: true },
        true,
      );
      await notifications.reminders();
      await notifications.reminders();
      const rows = (
        await f.db.query("SELECT * FROM notification_deliveries WHERE kind='event-reminder' AND user_id=$1", [
          receiver.principal.userId,
        ])
      ).rows;
      expect(rows).toHaveLength(1);
      await publish(rows[0]!.id);
      const detail = (await notifications.detail(receiver.principal, rows[0]!.id)).data;
      expect(detail.target).toEqual({ kind: 'ticket', id: ticket.id });
      expect(detail.text).toContain('Europe/Rome');
      await f.db.query('UPDATE orders SET cancellation_requested=true WHERE id=$1', [order.data.id]);
      expect(await notifications.mayEmail(rows[0]!.id)).toBe(false);
    });
  },
);
