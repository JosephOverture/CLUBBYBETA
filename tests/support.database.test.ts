import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { commerceFixture } from './commerce-fixture';
import { BookingSupportService } from '../apps/api/src/commerce/support.service';
import { OrdersService } from '../apps/api/src/commerce/orders.service';
import { InventoryService } from '../apps/api/src/commerce/inventory.service';
import { OrganizationsService } from '../apps/api/src/organizations/organizations.service';
describe.skipIf(!process.env.TEST_DATABASE_URL)('support conversations and operational permissions', () => {
  let f: Awaited<ReturnType<typeof commerceFixture>>, support: BookingSupportService;
  beforeAll(async () => {
    f = await commerceFixture();
    support = f.app.get(BookingSupportService);
  });
  afterAll(async () => {
    if (f) await f.close();
  });
  async function booking(paid = false) {
    const buyer = await f.actor(),
      offer = await f.offer(),
      orders = f.app.get(OrdersService);
    const product = await f.app
      .get(InventoryService)
      .product(f.owner.principal, offer.occurrenceId, {
        name: 'Support admission',
        priceMinor: 1000,
        taxBps: 0,
        capacity: 10,
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
    if (paid) {
      const p = await orders.startPayment(buyer.principal, order.data.id, true);
      await orders.applyPayment(f.provider.sellerValue.id, f.provider.succeed(p.data.paymentIntentId));
    }
    return { buyer, id: order.data.id };
  }
  async function staff(role = 'manager', venues: string[] | null = null) {
    const actor = await f.actor();
    await f.db.query(
      'INSERT INTO memberships(id,organization_id,user_id,role,venue_ids) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), f.org, actor.principal.userId, role, venues],
    );
    return actor;
  }
  const input = {
    subject: 'Booking entry question',
    message: 'Please confirm where to present this admission ticket.',
  };
  it('deduplicates creation, prevents parallel duplicate cases and returns only the account holder’s conversations', async () => {
    const b = await booking(),
      key = randomUUID();
    const c = await support.create(b.buyer.principal, b.id, input, key);
    expect(await support.create(b.buyer.principal, b.id, input, key)).toEqual(c);
    await expect(support.create(b.buyer.principal, b.id, input, randomUUID())).rejects.toMatchObject({
      code: 'CASE_EXISTS',
    });
    const outsider = await f.actor();
    expect((await support.list(outsider.principal)).data).toHaveLength(0);
    await expect(support.view(outsider.principal, c.data.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await support.list(b.buyer.principal)).data[0]!.id).toBe(c.data.id);
    expect(
      (
        await f.db.query(
          "SELECT id FROM notification_deliveries WHERE user_id=$1 AND kind='support-update'",
          [f.owner.principal.userId],
        )
      ).rowCount,
    ).toBeGreaterThan(0);
  });
  it('enforces venue-scoped support permissions and excludes door/editor/finance roles from conversations', async () => {
    const b = await booking(),
      c = await support.create(b.buyer.principal, b.id, input, randomUUID()),
      manager = await staff('manager', ['group-venue']),
      wrong = await staff('manager', ['another-venue']);
    expect((await support.list(manager.principal, f.org)).data.some((row) => row.id === c.data.id)).toBe(
      true,
    );
    expect((await support.list(wrong.principal, f.org)).data).toHaveLength(0);
    await expect(support.view(wrong.principal, c.data.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const role of ['door', 'editor', 'finance']) {
      const user = await staff(role);
      await expect(support.view(user.principal, c.data.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(support.list(user.principal, f.org)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    const caps = (await f.app.get(OrganizationsService).capabilities(manager.principal)).data;
    expect(caps.organizations[0]!.permissions).toContain('support.manage');
    expect(caps.organizations[0]!.venueIds).toEqual(['group-venue']);
  });
  it('version-checks staff/customer replies, limits waiting state to staff and notifies the other participants', async () => {
    const b = await booking(),
      c = await support.create(b.buyer.principal, b.id, input, randomUUID());
    await expect(
      support.reply(
        b.buyer.principal,
        c.data.id,
        { message: 'Waiting for your response', status: 'waiting', expectedVersion: 1 },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS' });
    const result = await Promise.allSettled([
      support.reply(
        f.owner.principal,
        c.data.id,
        { message: 'Please use the main entrance.', status: 'waiting', expectedVersion: 1 },
        randomUUID(),
      ),
      support.reply(
        f.owner.principal,
        c.data.id,
        { message: 'Here is another response.', status: 'waiting', expectedVersion: 1 },
        randomUUID(),
      ),
    ]);
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const view = await support.view(b.buyer.principal, c.data.id);
    expect(view.data.messages).toHaveLength(2);
    expect(view.data.version).toBe(2);
    const row = (
      await f.db.query(
        "SELECT target FROM notification_deliveries WHERE user_id=$1 AND kind='support-update'",
        [b.buyer.principal.userId],
      )
    ).rows[0]!;
    expect(row.target).toEqual({ kind: 'support', id: c.data.id });
    await support.reply(
      b.buyer.principal,
      c.data.id,
      { message: 'Thank you, this resolves it.', status: 'resolved', expectedVersion: 2 },
      randomUUID(),
    );
    expect((await support.view(b.buyer.principal, c.data.id)).data.resolved_at).toBeTruthy();
    await support.reply(
      b.buyer.principal,
      c.data.id,
      { message: 'I need some additional help.', status: 'open', expectedVersion: 3 },
      randomUUID(),
    );
    expect((await support.view(b.buyer.principal, c.data.id)).data.resolved_at).toBeNull();
  });
  it('supports authorized platform queues and reasoned assignment to active support agents', async () => {
    const b = await booking(),
      c = await support.create(b.buyer.principal, b.id, input, randomUUID()),
      agent = await f.actor();
    await expect(support.list(b.buyer.principal, undefined, { platform: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(
      (await support.list(f.admin.principal, undefined, { platform: true, status: 'open' })).data.some(
        (row) => row.id === c.data.id,
      ),
    ).toBe(true);
    await expect(
      support.assign(f.admin.principal, c.data.id, {
        userId: agent.principal.userId,
        expectedVersion: 1,
        reason: 'Assign agent for a booking investigation',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ASSIGNEE' });
    await f.db.query("INSERT INTO platform_grants(user_id,role) VALUES($1,'support')", [
      agent.principal.userId,
    ]);
    await support.assign(f.admin.principal, c.data.id, {
      userId: agent.principal.userId,
      expectedVersion: 1,
      reason: 'Assign agent for a booking investigation',
    });
    const view = await support.view(agent.principal, c.data.id);
    expect(view.data.assigned_to).toBe(agent.principal.userId);
    await f.db.query('UPDATE platform_grants SET revoked_at=now() WHERE user_id=$1', [
      agent.principal.userId,
    ]);
    await expect(
      support.reply(
        agent.principal,
        c.data.id,
        { message: 'Revoked support reply', status: 'waiting', expectedVersion: 2 },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('paginates long histories without losing equal-timestamp messages', async () => {
    const b = await booking(),
      c = await support.create(b.buyer.principal, b.id, input, randomUUID());
    await f.db.query(
      "INSERT INTO support_messages(id,case_id,actor_id,body) SELECT gen_random_uuid(),$1,$2,'Historic message '||n FROM generate_series(1,105) n",
      [c.data.id, b.buyer.principal.userId],
    );
    const first = await support.view(b.buyer.principal, c.data.id),
      next = await support.view(b.buyer.principal, c.data.id, first.meta.nextCursor);
    expect(first.meta.hasMore).toBe(true);
    expect(next.data.messages).toHaveLength(6);
    expect(new Set([...first.data.messages, ...next.data.messages].map((m) => m.id)).size).toBe(106);
  });
  it('allows received-ticket support without exposing the purchaser’s order or unrelated cases', async () => {
    const b = await booking(true),
      receiver = await f.actor();
    const ticket = (await f.db.query('SELECT id FROM tickets WHERE order_id=$1', [b.id])).rows[0]!;
    await f.db.query('UPDATE tickets SET owner_id=$1 WHERE id=$2', [receiver.principal.userId, ticket.id]);
    const c = await support.createForTicket(receiver.principal, ticket.id, input, randomUUID());
    const view = await support.view(receiver.principal, c.data.id);
    expect(view.data.ticket_id).toBe(ticket.id);
    expect(view.data).not.toHaveProperty('buyer_email_encrypted');
    expect(view.data).not.toHaveProperty('snapshot');
    await expect(support.view(b.buyer.principal, c.data.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.app.get(OrdersService).view(receiver.principal, b.id)).rejects.toThrow();
  });
});
