import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { idSchema } from '@clubby/contracts';
import { Database } from '../platform/database';
import { ApiError } from '../platform/http';

export const BETA_COOKIE = 'clubby_beta';
export const BETA_SESSION_SECONDS = 90 * 24 * 60 * 60;
const tokenPattern = /^[a-f0-9]{64}$/;
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

export type BetaState = {
  saved: string[];
  plans: {
    id: string;
    venueId: string;
    name: string;
    note: string;
    date: string;
    createdAt: string;
    status: 'personal';
  }[];
  profile: { name: string; theme: 'dark' | 'light' };
};
export const emptyBetaState = (): BetaState => ({
  saved: [],
  plans: [],
  profile: { name: 'Guest', theme: 'dark' },
});

// Round-tripping catches impossible dates such as 2030-02-31 without allowing
// JavaScript's calendar overflow or PostgreSQL's broader date parser.
export const betaDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number(value.slice(0, 4)) >= 1 &&
    Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
export const betaPlanInput = z.object({
  venueId: idSchema,
  name: z.string().trim().min(1).max(80),
  note: z.string().trim().max(400).default(''),
  date: betaDateSchema,
}).strict();
export const betaProfileInput = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  theme: z.enum(['dark', 'light']).optional(),
}).strict().refine((value) => value.name !== undefined || value.theme !== undefined);

export class BetaService {
  constructor(readonly db: Database) {}

  private async state(tx: PoolClient, visitor: string): Promise<BetaState> {
    const profile = await tx.query<{ name: string; theme: 'dark' | 'light' }>(
      'SELECT profile_name AS name,theme FROM beta_visitors WHERE token_hash=$1', [visitor],
    );
    const saved = await tx.query<{ id: string }>(
      'SELECT venue_id AS id FROM beta_saved_venues WHERE visitor_hash=$1 ORDER BY created_at,venue_id',
      [visitor],
    );
    const plans = await tx.query<{ id: string; venueId: string; name: string; note: string; date: string; createdAt: Date }>(
      `SELECT id,venue_id AS "venueId",name,note,to_char(plan_date,'YYYY-MM-DD') AS date,created_at AS "createdAt"
       FROM beta_plans WHERE visitor_hash=$1 ORDER BY created_at DESC,id DESC`, [visitor],
    );
    return {
      saved: saved.rows.map((row) => row.id),
      plans: plans.rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString(), status: 'personal' })),
      profile: profile.rows[0]!,
    };
  }

  private async session(tx: PoolClient, cookie: string | undefined) {
    if (cookie && tokenPattern.test(cookie)) {
      const hash = digest(cookie);
      const existing = await tx.query(
        'SELECT token_hash FROM beta_visitors WHERE token_hash=$1 AND expires_at>now() FOR UPDATE', [hash],
      );
      if (existing.rowCount) return { hash, token: undefined };
    }
    // Bounded opportunistic cleanup also erases expired personal data. The expiry
    // index keeps this work independent of the total size of the visitor table.
    await tx.query(`DELETE FROM beta_visitors WHERE token_hash IN (
      SELECT token_hash FROM beta_visitors WHERE expires_at<=now() ORDER BY expires_at LIMIT 100
    )`);
    const token = randomBytes(32).toString('hex');
    const hash = digest(token);
    await tx.query('INSERT INTO beta_visitors(token_hash) VALUES($1)', [hash]);
    return { hash, token };
  }

  private async operate(
    cookie: string | undefined,
    action?: (tx: PoolClient, visitor: string) => Promise<void>,
  ) {
    return this.db.transaction(async (tx) => {
      const session = await this.session(tx, cookie);
      if (action) await action(tx, session.hash);
      return { data: await this.state(tx, session.hash), token: session.token };
    });
  }

  read(cookie: string | undefined) { return this.operate(cookie); }

  private async publicVenue(tx: PoolClient, id: string) {
    const venue = await tx.query(
      `SELECT v.id FROM venues v JOIN destinations d ON d.id=v.destination_id
       WHERE v.id=$1 AND v.status='published' AND d.published=true`, [id],
    );
    if (!venue.rowCount) throw new ApiError('NOT_FOUND', 'Venue not found.', 404);
  }

  save(cookie: string | undefined, rawId: string, raw: unknown) {
    const id = idSchema.parse(rawId);
    const { saved } = z.object({ saved: z.boolean() }).strict().parse(raw);
    return this.operate(cookie, async (tx, visitor) => {
      if (saved) {
        await this.publicVenue(tx, id);
        const count = await tx.query<{ total: string }>(
          'SELECT count(*) AS total FROM beta_saved_venues WHERE visitor_hash=$1', [visitor],
        );
        const existing = await tx.query(
          'SELECT 1 FROM beta_saved_venues WHERE visitor_hash=$1 AND venue_id=$2', [visitor, id],
        );
        if (!existing.rowCount && Number(count.rows[0]!.total) >= 300)
          throw new ApiError('LIMIT_REACHED', 'You can save up to 300 venues.', 409);
        await tx.query(
          'INSERT INTO beta_saved_venues(visitor_hash,venue_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
          [visitor, id],
        );
      } else {
        await tx.query('DELETE FROM beta_saved_venues WHERE visitor_hash=$1 AND venue_id=$2', [visitor, id]);
      }
    });
  }

  plan(cookie: string | undefined, raw: unknown) {
    const input = betaPlanInput.parse(raw);
    return this.operate(cookie, async (tx, visitor) => {
      await this.publicVenue(tx, input.venueId);
      const count = await tx.query<{ total: string }>(
        'SELECT count(*) AS total FROM beta_plans WHERE visitor_hash=$1', [visitor],
      );
      if (Number(count.rows[0]!.total) >= 100)
        throw new ApiError('LIMIT_REACHED', 'You can keep up to 100 personal plans.', 409);
      await tx.query(
        'INSERT INTO beta_plans(id,visitor_hash,venue_id,name,note,plan_date) VALUES($1,$2,$3,$4,$5,$6)',
        [randomUUID(), visitor, input.venueId, input.name, input.note, input.date],
      );
    });
  }

  removePlan(cookie: string | undefined, rawId: string) {
    const id = z.string().uuid().parse(rawId);
    return this.operate(cookie, async (tx, visitor) => {
      // Repeating a delete is harmless; another visitor's ID reveals no data.
      await tx.query('DELETE FROM beta_plans WHERE visitor_hash=$1 AND id=$2', [visitor, id]);
    });
  }

  profile(cookie: string | undefined, raw: unknown) {
    const input = betaProfileInput.parse(raw);
    return this.operate(cookie, async (tx, visitor) => {
      await tx.query(
        `UPDATE beta_visitors SET profile_name=COALESCE($2,profile_name),theme=COALESCE($3,theme)
         WHERE token_hash=$1`, [visitor, input.name ?? null, input.theme ?? null],
      );
    });
  }

  async reset(cookie: string | undefined) {
    if (cookie && tokenPattern.test(cookie))
      await this.db.query('DELETE FROM beta_visitors WHERE token_hash=$1', [digest(cookie)]);
    return { data: emptyBetaState() };
  }
}
