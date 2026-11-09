import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Database } from '../platform/database';
import { ApiError } from '../platform/http';
import { decrypt, encrypt, hash, secret, equalHash } from '../platform/crypto';
import { enqueue } from '../platform/jobs';
import type { Principal } from '../identity/identity.service';
import { TransfersService } from './transfers.service';
import { type WalletProvider, type WalletTicket, SignedWalletProvider } from './wallet-provider';
import { requireFeature } from '../administration/features';
const deviceSchema = z.string().regex(/^[A-Za-z0-9_-]{16,200}$/);
const pushSchema = z.string().regex(/^[a-fA-F0-9]{32,256}$/);
export class WalletService {
  constructor(
    readonly db: Database,
    readonly transfers: TransfersService,
    readonly provider: WalletProvider = new SignedWalletProvider(db.config),
  ) {}
  async issue(actor: Principal, ticketId: string, raw: unknown) {
    const input = z
      .object({ wallet: z.enum(['apple', 'google']) })
      .strict()
      .parse(raw);
    if (!this.provider.capabilities()[input.wallet])
      throw new ApiError('WALLET_NOT_CONFIGURED', 'This wallet is not configured yet.', 503);
    const id = await this.db.transaction(async (tx) => {
      await requireFeature(tx, 'walletCreation');
      const { ticket, order } = await this.transfers.locked(tx, ticketId);
      if (ticket.owner_id !== actor.userId) throw new ApiError('NOT_FOUND', 'Ticket not found.', 404);
      if (
        input.wallet === 'google' &&
        !(await tx.query('SELECT id FROM venues WHERE id=$1 AND length(trim(address))>0', [order.venue_id]))
          .rowCount
      )
        throw new ApiError(
          'WALLET_UNAVAILABLE',
          'The seller must complete the venue address before this pass can be issued.',
          409,
        );
      if (
        ticket.status !== 'valid' ||
        !['paid', 'partially-refunded', 'refund-pending'].includes(order.status) ||
        order.dispute_open ||
        order.cancellation_requested
      )
        throw new ApiError('TICKET_INACTIVE', 'An active ticket is required to create a wallet pass.', 409);
      const auth = secret(),
        passId = randomUUID();
      const pass = (
        await tx.query(
          `INSERT INTO wallet_passes(id,ticket_id,owner_id,credential_version,auth_hash,auth_encrypted)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(ticket_id,credential_version) DO UPDATE SET ticket_id=EXCLUDED.ticket_id RETURNING id`,
          [
            passId,
            ticketId,
            actor.userId,
            ticket.credential_version,
            hash(auth),
            encrypt(auth, this.db.config.encryptionKeys),
          ],
        )
      ).rows[0];
      await tx.query(
        `UPDATE wallet_passes SET ${input.wallet === 'apple' ? 'apple_requested' : 'google_requested'}=true WHERE id=$1`,
        [pass.id],
      );
      return pass.id as string;
    });
    if (input.wallet === 'google') {
      await this.sync(id);
      // Recheck ownership after provider work, which intentionally runs outside a database transaction.
      const current = await this.projection(id);
      if (!current.active)
        throw new ApiError('TICKET_INACTIVE', 'The ticket changed while creating its wallet pass.', 409);
      return { data: { url: await this.provider.googleSave(id), expiresInSeconds: 300 } };
    }
    const token = secret();
    await this.db.query(
      "INSERT INTO wallet_downloads(token_hash,pass_id,session_id,expires_at) VALUES($1,$2,$3,now()+interval '2 minutes')",
      [hash(token), id, actor.sessionId],
    );
    return {
      data: { url: `${this.db.config.PUBLIC_API_URL}/v1/wallet/download/${token}`, expiresInSeconds: 120 },
    };
  }
  async projection(id: string): Promise<WalletTicket> {
    const r = (
      await this.db.query(
        `SELECT p.*,t.owner_id AS ticket_owner,t.credential_version AS ticket_version,t.credential_encrypted,t.status AS ticket_status,
      t.admitted_at,t.drinks_total,t.drinks_used,t.occurrence_id,o.status AS order_status,o.snapshot,o.dispute_open,o.cancellation_requested,o.currency,
      e.starts_at,e.ends_at,e.status AS occurrence_status,u.status AS user_status,v.address,r.status AS table_status,
      r.full_price_minor,r.online_amount_minor,coalesce((SELECT sum(c.amount_minor) FROM door_collections c WHERE c.reservation_id=r.id),0)::int AS collected
      FROM wallet_passes p JOIN tickets t ON t.id=p.ticket_id JOIN orders o ON o.id=t.order_id JOIN occurrences e ON e.id=t.occurrence_id
      JOIN users u ON u.id=p.owner_id JOIN venues v ON v.id=o.venue_id LEFT JOIN table_reservations r ON r.order_id=o.id WHERE p.id=$1`,
        [id],
      )
    ).rows[0];
    if (!r) throw new ApiError('NOT_FOUND', 'Wallet pass not found.', 404);
    const current = r.owner_id === r.ticket_owner && r.credential_version === r.ticket_version;
    const active =
      current &&
      r.ticket_status === 'valid' &&
      !r.dispute_open &&
      !r.cancellation_requested &&
      r.occurrence_status !== 'cancelled' &&
      r.user_status === 'active' &&
      ['paid', 'partially-refunded', 'refund-pending'].includes(r.order_status) &&
      (!r.table_status || r.table_status === 'confirmed') &&
      (!r.admitted_at || r.drinks_used < r.drinks_total) &&
      Date.now() < r.ends_at.getTime() + 6 * 3600_000;
    const snapshot = r.snapshot;
    return {
      id: r.id,
      ticketId: r.ticket_id,
      occurrenceId: r.occurrence_id,
      revision: r.revision,
      authToken: decrypt(r.auth_encrypted, this.db.config.encryptionKeys) as string,
      credential: active
        ? (decrypt(r.credential_encrypted, this.db.config.encryptionKeys) as string)
        : null,
      active,
      title: snapshot.title,
      venueName: snapshot.venueName,
      venueAddress: r.address,
      startsAt: snapshot.table?.slotStartsAt ?? r.starts_at.toISOString(),
      endsAt: snapshot.table?.slotEndsAt ?? r.ends_at.toISOString(),
      timezone: snapshot.timezone,
      terms:
        snapshot.terms +
        (snapshot.table
          ? `\n${snapshot.table.terms}\nThe booking owner can cancel the whole reservation.`
          : ''),
      status: !active ? 'Inactive' : r.admitted_at ? 'Admitted — drinks available' : 'Valid admission',
      drinksRemaining: current ? Math.max(0, r.drinks_total - r.drinks_used) : 0,
      tableLabel: snapshot.table?.table?.label ?? null,
      balanceDueMinor: current
        ? Math.max(0, (r.full_price_minor ?? 0) - (r.online_amount_minor ?? 0) - r.collected)
        : 0,
      currency: r.currency,
    };
  }
  async download(token: string, head = false) {
    z.string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .parse(token);
    const passId = await this.db.transaction(async (tx) => {
      const row = (
        await tx.query(
          `SELECT d.*,p.owner_id,t.owner_id AS current_owner,p.credential_version,t.credential_version AS current_version
        FROM wallet_downloads d JOIN wallet_passes p ON p.id=d.pass_id JOIN tickets t ON t.id=p.ticket_id JOIN sessions s ON s.id=d.session_id JOIN users u ON u.id=s.user_id
        WHERE d.token_hash=$1 AND d.used_at IS NULL AND d.expires_at>now() AND s.revoked_at IS NULL AND s.expires_at>now() AND u.status='active' FOR UPDATE OF d`,
          [hash(token)],
        )
      ).rows[0];
      if (!row || row.owner_id !== row.current_owner || row.credential_version !== row.current_version)
        throw new ApiError('NOT_FOUND', 'Download link expired or was already used.', 404);
      // Generate before consuming a one-use link: missing signing material must remain retryable.
      const pass = await this.projection(row.pass_id);
      const buffer = await this.provider.applePass(pass);
      if (!head)
        await tx.query('UPDATE wallet_downloads SET used_at=now() WHERE token_hash=$1', [hash(token)]);
      return buffer;
    });
    return passId;
  }
  async authorize(passType: string, id: string, authorization?: string) {
    z.string().uuid().parse(id);
    const token = authorization?.startsWith('ApplePass ') ? authorization.slice(10) : '';
    const pass = (
      await this.db.query('SELECT * FROM wallet_passes WHERE id=$1 AND apple_requested=true', [id])
    ).rows[0];
    if (passType !== this.db.config.APPLE_PASS_TYPE_ID || !pass || !equalHash(token, pass.auth_hash))
      throw new ApiError('UNAUTHORIZED', 'Invalid pass authorization.', 401);
    return pass;
  }
  async appleUpdate(passType: string, id: string, authorization?: string) {
    await this.authorize(passType, id, authorization);
    return this.provider.applePass(await this.projection(id));
  }
  async register(
    device: string,
    passType: string,
    id: string,
    authorization: string | undefined,
    raw: unknown,
  ) {
    await this.authorize(passType, id, authorization);
    const deviceHash = hash(deviceSchema.parse(device)),
      input = z.object({ pushToken: pushSchema }).strict().parse(raw);
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,74))', [deviceHash]);
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,74))', [id]);
      const existing = await tx.query(
        'SELECT 1 FROM wallet_registrations WHERE device_hash=$1 AND pass_id=$2',
        [deviceHash, id],
      );
      if (
        !existing.rowCount &&
        (
          await tx.query('SELECT count(*)::int n FROM wallet_registrations WHERE device_hash=$1', [
            deviceHash,
          ])
        ).rows[0].n >= 500
      )
        throw new ApiError('DEVICE_LIMIT', 'This device has too many pass registrations.', 429);
      if (
        !existing.rowCount &&
        (await tx.query('SELECT count(*)::int n FROM wallet_registrations WHERE pass_id=$1', [id])).rows[0]
          .n >= 20
      )
        throw new ApiError('DEVICE_LIMIT', 'This pass has too many registrations.', 429);
      await tx.query(
        'INSERT INTO wallet_registrations(device_hash,pass_id,push_encrypted) VALUES($1,$2,$3) ON CONFLICT(device_hash,pass_id) DO UPDATE SET push_encrypted=EXCLUDED.push_encrypted',
        [deviceHash, id, encrypt(input.pushToken, this.db.config.encryptionKeys)],
      );
      return existing.rowCount ? 200 : 201;
    });
  }
  async unregister(device: string, passType: string, id: string, authorization?: string) {
    await this.authorize(passType, id, authorization);
    await this.db.query('DELETE FROM wallet_registrations WHERE device_hash=$1 AND pass_id=$2', [
      hash(deviceSchema.parse(device)),
      id,
    ]);
  }
  async updates(device: string, passType: string, since?: string) {
    if (passType !== this.db.config.APPLE_PASS_TYPE_ID)
      throw new ApiError('NOT_FOUND', 'Pass type not found.', 404);
    if (since) z.string().max(100).parse(since);
    const rows = (
      await this.db.query(
        `SELECT p.id,p.revision FROM wallet_registrations r JOIN wallet_passes p ON p.id=r.pass_id WHERE r.device_hash=$1 ORDER BY p.id`,
        [hash(deviceSchema.parse(device))],
      )
    ).rows;
    // Opaque snapshot digest avoids losing updates when transactions commit out of sequence.
    const lastUpdated = hash(JSON.stringify(rows));
    if (!rows.length || lastUpdated === since) return null;
    return { serialNumbers: rows.map((r) => r.id), lastUpdated };
  }
  async sync(id: string) {
    const pass = (await this.db.query('SELECT * FROM wallet_passes WHERE id=$1', [id])).rows[0];
    if (!pass) return;
    const ticket = await this.projection(id),
      cap = this.provider.capabilities();
    if (pass.google_requested && cap.google) {
      await this.provider.googleUpdate(ticket);
      await this.db.query(
        'UPDATE wallet_passes SET google_synced_revision=greatest(google_synced_revision,$2) WHERE id=$1',
        [id, ticket.revision],
      );
    }
    if (pass.apple_requested && cap.apple) {
      const registrations = (
        await this.db.query('SELECT device_hash,push_encrypted FROM wallet_registrations WHERE pass_id=$1', [
          id,
        ])
      ).rows;
      await Promise.all(
        registrations.map(async (r) => {
          const result = await this.provider.applePush(
            decrypt(r.push_encrypted, this.db.config.encryptionKeys) as string,
          );
          if (result === 'unregistered')
            await this.db.query(
              'DELETE FROM wallet_registrations WHERE pass_id=$1 AND device_hash=$2 AND push_encrypted=$3',
              [id, r.device_hash, r.push_encrypted],
            );
        }),
      );
      await this.db.query(
        'UPDATE wallet_passes SET apple_notified_revision=greatest(apple_notified_revision,$2) WHERE id=$1',
        [id, ticket.revision],
      );
    }
    await this.db.query('UPDATE wallet_passes SET checked_at=now() WHERE id=$1', [id]);
  }
  async maintenance() {
    await this.db.transaction(async (tx) => {
      const rows = (
        await tx.query(`SELECT p.id,p.revision FROM wallet_passes p JOIN tickets t ON t.id=p.ticket_id JOIN occurrences e ON e.id=t.occurrence_id
        WHERE (p.apple_requested AND p.apple_notified_revision<p.revision) OR (p.google_requested AND p.google_synced_revision<p.revision)
        OR ((p.apple_requested OR p.google_requested) AND e.ends_at>now()-interval '7 days' AND (p.checked_at IS NULL OR p.checked_at<now()-interval '1 hour'))
        ORDER BY p.checked_at NULLS FIRST,p.id LIMIT 200`)
      ).rows;
      for (const r of rows)
        await enqueue(tx, 'wallet.sync', `${r.id}:${r.revision}:${Math.floor(Date.now() / 3600_000)}`, {
          passId: r.id,
        });
      await tx.query("DELETE FROM wallet_downloads WHERE expires_at<now()-interval '1 day'");
    });
  }
}
