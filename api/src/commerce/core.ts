import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { hash, encrypt } from '../platform/crypto';
import type { Config } from '../platform/config';
import { ApiError } from '../platform/http';
import { enqueue } from '../platform/jobs';

export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}
export async function idempotent<T>(
  tx: PoolClient,
  userId: string,
  operation: string,
  key: unknown,
  payload: unknown,
  action: () => Promise<T>,
): Promise<T> {
  const parsed = z
    .string()
    .min(16)
    .max(100)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .parse(key);
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,41))', [
    `${userId}:${operation}:${parsed}`,
  ]);
  const digest = hash(canonical(payload));
  const previous = (
    await tx.query(
      'SELECT payload_hash,response FROM api_idempotency WHERE user_id=$1 AND operation=$2 AND key=$3',
      [userId, operation, parsed],
    )
  ).rows[0];
  if (previous) {
    if (previous.payload_hash !== digest)
      throw new ApiError('IDEMPOTENCY_CONFLICT', 'This key was already used for different input.', 409);
    return previous.response as T;
  }
  const response = await action();
  await tx.query(
    'INSERT INTO api_idempotency(user_id,operation,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)',
    [userId, operation, parsed, digest, JSON.stringify(response)],
  );
  return response;
}
export async function journal(
  tx: PoolClient,
  reference: string,
  currency: string,
  orderId: string | null,
  description: string,
  postings: Record<string, number>,
  book: 'commerce' | 'provider' = 'commerce',
) {
  const entries = Object.entries(postings).filter(([, amount]) => amount !== 0);
  if (
    entries.some(([, amount]) => !Number.isSafeInteger(amount)) ||
    entries.reduce((sum, [, amount]) => sum + amount, 0) !== 0
  )
    throw new Error('Unbalanced or unsafe monetary posting.');
  if (!entries.length) return;
  const id = randomUUID();
  const inserted = await tx.query(
    'INSERT INTO ledger_journals(id,reference,currency,order_id,description,book) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(reference) DO NOTHING RETURNING id',
    [id, reference, currency, orderId, description, book],
  );
  if (!inserted.rowCount) return;
  for (const [account, amount] of entries)
    await tx.query('INSERT INTO ledger_postings(journal_id,account,amount_minor) VALUES($1,$2,$3)', [
      id,
      account,
      amount,
    ]);
}
export async function notifyBuyer(
  tx: PoolClient,
  config: Config,
  userId: string | null,
  email: string,
  kind: string,
  subject: string,
  text: string,
  dedupeKey: string,
  target?: { kind: 'booking' | 'group' | 'ticket' | 'support'; id: string },
) {
  // Enqueue and mail record commit with the domain operation. No email address enters the job payload.
  if (userId) {
    const user = (await tx.query('SELECT status FROM users WHERE id=$1', [userId])).rows[0];
    if (user && ['deletion-pending', 'deleted'].includes(user.status)) return;
  }
  email = z.string().email().parse(email.trim().toLowerCase());
  // Bind to the recipient, never a caller-supplied inviter. Guest notifications are claimed on verification.
  const recipient = (
    await tx.query('SELECT id FROM users WHERE email=$1 AND email_verified_at IS NOT NULL', [email])
  ).rows[0];
  const guest =
    !recipient && userId
      ? (await tx.query("SELECT id FROM users WHERE id=$1 AND kind='guest'", [userId])).rows[0]
      : null;
  const id = randomUUID();
  const inserted = await tx.query(
    'INSERT INTO notification_deliveries(id,user_id,kind,encrypted_payload,recipient_hash,dedupe_key,target) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(dedupe_key) DO NOTHING RETURNING id',
    [
      id,
      recipient?.id ?? guest?.id ?? null,
      kind,
      encrypt({ to: email, subject, text }, config.encryptionKeys),
      hash(email),
      dedupeKey,
      target ? JSON.stringify(target) : null,
    ],
  );
  if (inserted.rowCount) await enqueue(tx, 'notification.deliver', dedupeKey, { deliveryId: id });
}
export function distribute(total: number, count: number, index: number) {
  return Math.floor(total / count) + (index < total % count ? 1 : 0);
}
