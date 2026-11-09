import type { Database } from './database';
import { decrypt, encrypt } from './crypto';
import { audit } from '../organizations/organizations.service';

/** Maintenance-only atomic rewrap; current format remains readable by the overlap deployment. */
export async function rotateEncryption(db: Database) {
  const ring = db.config.encryptionKeys;
  if (ring.length < 2)
    throw new Error('Configure the new active key and the previous key before rewrapping.');
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(42819211)');
    const columns = (
      await tx.query<{ table_name: string; column_name: string }>(`
      SELECT table_name,column_name FROM information_schema.columns
      WHERE table_schema='public' AND data_type='text' AND (column_name LIKE '%_encrypted' OR column_name='encrypted_payload')
      ORDER BY table_name,column_name`)
    ).rows;
    if (
      !columns.length ||
      columns.some((c) => !(/^[a-z_]+$/.test(c.table_name) && /^[a-z_]+$/.test(c.column_name)))
    )
      throw new Error('Unexpected encryption storage schema.');
    // Acquire every table in a stable order before reading any ciphertext. Services must be drained first.
    for (const table of [...new Set(columns.map((c) => c.table_name))])
      await tx.query(`LOCK TABLE "${table}" IN ACCESS EXCLUSIVE MODE`);
    let scanned = 0,
      rewrapped = 0;
    for (const { table_name: table, column_name: column } of columns) {
      let cursor = '(0,0)';
      while (true) {
        const batch = (
          await tx.query<{ row_id: string; value: string }>(
            `SELECT ctid::text AS row_id,"${column}" AS value FROM "${table}" WHERE ctid>$1::tid AND "${column}" IS NOT NULL ORDER BY ctid LIMIT 500`,
            [cursor],
          )
        ).rows;
        if (!batch.length) break;
        cursor = batch.at(-1)!.row_id;
        for (const row of batch) {
          scanned++;
          try {
            decrypt(row.value, ring[0]);
            continue;
          } catch {
            /* Old key or corrupt data; full-ring authentication below must succeed. */
          }
          const replacement = encrypt(decrypt(row.value, ring), ring[0]);
          await tx.query(`UPDATE "${table}" SET "${column}"=$1 WHERE ctid=$2::tid`, [
            replacement,
            row.row_id,
          ]);
          rewrapped++;
        }
      }
    }
    await audit(
      tx,
      null,
      'encryption.rotate',
      'database',
      db.config.APP_ENV,
      'Maintenance rewrap using configured overlap keys',
      { columns: columns.length, rewrapped },
    );
    return { columns: columns.length, scanned, rewrapped };
  });
}
