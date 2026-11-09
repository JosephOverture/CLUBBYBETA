import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Database } from '../platform/database';
import { ApiError } from '../platform/http';
import type { Principal } from '../identity/identity.service';
import { OrganizationsService, audit } from '../organizations/organizations.service';
import { idempotent, notifyBuyer } from '../commerce/core';
import { GroupsService } from './groups.service';
import { groupEvent } from './group-events';
import { requireFeature } from '../administration/features';
const cursor = (value: unknown) =>
  z
    .string()
    .regex(/^\d{1,18}$/)
    .default('0')
    .parse(value);
export class ChatService {
  constructor(
    readonly db: Database,
    readonly groups: GroupsService,
    readonly organizations: OrganizationsService,
  ) {}
  async send(actor: Principal, id: string, raw: unknown, key: unknown) {
    const input = z
      .object({ body: z.string().trim().min(1).max(2000) })
      .strict()
      .parse(raw);
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(input.body))
      throw new ApiError('INVALID_MESSAGE', 'Remove control characters from the message.', 400);
    return this.db.transaction((tx) =>
      idempotent(tx, actor.userId, `chat.send:${id}`, key, input, async () => {
        await requireFeature(tx, 'chatMessages');
        const { group, order } = await this.groups.lock(tx, id, actor);
        if (Date.now() > Date.parse(order.snapshot.endsAt) + 90 * 86400_000)
          throw new ApiError('CHAT_ARCHIVED', 'This conversation has reached its retention limit.', 409);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,54))', [actor.userId]);
        if (
          Number(
            (
              await tx.query(
                "SELECT count(*) AS n FROM group_messages WHERE author_id=$1 AND created_at>now()-interval '1 minute'",
                [actor.userId],
              )
            ).rows[0].n,
          ) >= 20
        )
          throw new ApiError('MESSAGE_LIMIT', 'Wait before sending another message.', 429);
        const messageId = randomUUID(),
          message = (
            await tx.query(
              'INSERT INTO group_messages(id,group_id,author_id,body) VALUES($1,$2,$3,$4) RETURNING sequence,created_at',
              [messageId, group.id, actor.userId, input.body],
            )
          ).rows[0]!;
        await groupEvent(tx, id, 'message', { messageId, authorId: actor.userId });
        const recipients = (
          await tx.query(
            `SELECT u.id,u.email FROM group_members m JOIN users u ON u.id=m.user_id WHERE m.group_id=$1 AND m.status='active' AND u.status='active' AND u.email IS NOT NULL AND u.id<>$2 AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE b.user_id=u.id AND b.blocked_user_id=$2) ORDER BY u.id`,
            [id, actor.userId],
          )
        ).rows;
        for (const recipient of recipients)
          await notifyBuyer(
            tx,
            this.db.config,
            recipient.id,
            recipient.email,
            'group-message',
            'New messages in your Clubby group',
            'Open the group conversation in Clubby to read new messages.',
            `group-message:${id}:${recipient.id}:${Math.floor(Date.now() / 300_000)}`,
            { kind: 'group', id },
          );
        return {
          data: {
            id: messageId,
            sequence: String(message.sequence),
            createdAt: message.created_at.toISOString(),
          },
        };
      }),
    );
  }
  async history(actor: Principal, id: string, after: unknown) {
    return this.db.transaction(async (tx) => {
      await this.groups.member(tx, id, actor);
      const rows = (
        await tx.query(
          'SELECT m.id,m.sequence::text,m.author_id AS "authorId",u.display_name AS "displayName",m.body,m.created_at AS "createdAt" FROM group_messages m JOIN users u ON u.id=m.author_id WHERE m.group_id=$1 AND m.sequence>$2 AND m.status=\'visible\' AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE b.user_id=$3 AND b.blocked_user_id=m.author_id) ORDER BY m.sequence LIMIT 100',
          [id, cursor(after), actor.userId],
        )
      ).rows;
      const last = rows.at(-1)?.sequence ?? cursor(after);
      return { data: rows, meta: { nextCursor: last, hasMore: rows.length === 100 } };
    });
  }
  async events(actor: Principal, id: string, after: unknown) {
    return this.db.transaction(async (tx) => {
      await this.groups.member(tx, id, actor);
      const rows = (
        await tx.query(
          "SELECT sequence::text,kind,payload,created_at AS \"createdAt\" FROM group_events e WHERE group_id=$1 AND sequence>$2 AND (kind<>'message' OR NOT EXISTS(SELECT 1 FROM user_blocks b WHERE b.user_id=$3 AND b.blocked_user_id::text=e.payload->>'authorId')) ORDER BY sequence LIMIT 100",
          [id, cursor(after), actor.userId],
        )
      ).rows;
      return {
        data: rows,
        meta: {
          nextCursor: rows.at(-1)?.sequence ?? cursor(after),
          hasMore: rows.length === 100,
          pollAfterMs: 5000,
        },
      };
    });
  }
  async block(actor: Principal, targetId: string, blocked: boolean) {
    this.organizations.verified(actor);
    if (targetId === actor.userId) throw new ApiError('INVALID_BLOCK', 'Choose another group member.', 400);
    return this.db.transaction(async (tx) => {
      if (
        !(
          await tx.query(
            "SELECT a.group_id FROM group_members a JOIN group_members b ON b.group_id=a.group_id WHERE a.user_id=$1 AND b.user_id=$2 AND a.status='active' LIMIT 1",
            [actor.userId, targetId],
          )
        ).rowCount
      )
        throw new ApiError('NOT_FOUND', 'Group member not found.', 404);
      if (blocked)
        await tx.query(
          'INSERT INTO user_blocks(user_id,blocked_user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
          [actor.userId, targetId],
        );
      else
        await tx.query('DELETE FROM user_blocks WHERE user_id=$1 AND blocked_user_id=$2', [
          actor.userId,
          targetId,
        ]);
      return { data: { blocked } };
    });
  }
  async report(actor: Principal, id: string, messageId: string, reason: string) {
    z.string().trim().min(10).max(2000).parse(reason);
    return this.db.transaction(async (tx) => {
      await this.groups.member(tx, id, actor);
      if (
        !(await tx.query('SELECT id FROM group_messages WHERE id=$1 AND group_id=$2', [messageId, id]))
          .rowCount
      )
        throw new ApiError('NOT_FOUND', 'Message not found.', 404);
      const report = (
        await tx.query(
          'INSERT INTO message_reports(id,message_id,reporter_id,reason) VALUES($1,$2,$3,$4) ON CONFLICT(message_id,reporter_id) DO UPDATE SET reason=message_reports.reason RETURNING id',
          [randomUUID(), messageId, actor.userId, reason],
        )
      ).rows[0]!;
      return { data: { id: report.id } };
    });
  }
  private async moderator(actor: Principal, tx: Pick<Database, 'query'> = this.db) {
    this.organizations.verified(actor);
    if (
      !(
        await tx.query(
          "SELECT role FROM platform_grants WHERE user_id=$1 AND role IN ('admin','support') AND revoked_at IS NULL",
          [actor.userId],
        )
      ).rowCount
    )
      throw new ApiError('FORBIDDEN', 'Platform moderation permission required.', 403);
  }
  async reports(actor: Principal) {
    await this.moderator(actor);
    return {
      data: (
        await this.db.query(
          "SELECT r.*,m.body,m.group_id,m.author_id FROM message_reports r JOIN group_messages m ON m.id=r.message_id WHERE r.status='open' ORDER BY r.created_at LIMIT 100",
        )
      ).rows,
    };
  }
  async moderate(actor: Principal, id: string, raw: unknown) {
    const input = z
      .object({ action: z.enum(['hide', 'dismiss']), reason: z.string().min(10).max(2000) })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      await this.moderator(actor, tx);
      const report = (
        await tx.query(
          'SELECT r.*,m.group_id FROM message_reports r JOIN group_messages m ON m.id=r.message_id WHERE r.id=$1 FOR UPDATE OF r',
          [id],
        )
      ).rows[0];
      if (!report) throw new ApiError('NOT_FOUND', 'Report not found.', 404);
      if (input.action === 'hide')
        await tx.query("UPDATE group_messages SET status='hidden' WHERE id=$1 AND status='visible'", [
          report.message_id,
        ]);
      await tx.query(
        "UPDATE message_reports SET status='resolved',resolution=$1,resolved_by=$2,resolved_at=now() WHERE id=$3",
        [input.reason, actor.userId, id],
      );
      await audit(tx, actor.userId, 'chat.moderate', 'message-report', id, input.reason, {
        action: input.action,
      });
      await groupEvent(tx, report.group_id, 'moderation', { messageId: report.message_id });
      return { data: { resolved: true } };
    });
  }
}
