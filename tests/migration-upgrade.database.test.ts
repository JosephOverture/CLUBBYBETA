import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { it, expect } from 'vitest';
import { isolatedDatabase } from './database-helper';
import { migrate } from '../apps/api/src/platform/migrations';

it.skipIf(!process.env.TEST_DATABASE_URL)(
  'upgrades populated M4 order lines without changing purchased financial records',
  async () => {
    const { db, dispose } = await isolatedDatabase(),
      folder = await mkdtemp(join(tmpdir(), 'clubby-upgrade-')),
      source = resolve('database/migrations'),
      id = randomUUID();
    try {
      for (const file of (await readdir(source)).filter((f) => /^00[1-4]_/.test(f)))
        await copyFile(join(source, file), join(folder, file));
      await migrate(db, folder);
      await db.query("INSERT INTO users(id,kind) VALUES($1,'guest')", [id]);
      await db.query("INSERT INTO organizations(id,name,country_code) VALUES($1,'Legacy seller','IT')", [id]);
      await db.query(
        "INSERT INTO destinations(id,name,country_code,timezone,currency) VALUES('milan','Milan','IT','Europe/Rome','EUR')",
      );
      await db.query("INSERT INTO venues(id,destination_id,name) VALUES('legacy','milan','Legacy venue')");
      await db.query(
        "INSERT INTO events(id,venue_id,organization_id,title) VALUES($1,'legacy',$1,'Legacy event')",
        [id],
      );
      await db.query(
        "INSERT INTO occurrences(id,event_id,starts_at,ends_at,timezone,currency,capacity) VALUES($1,$1,now(),now()+interval '1 day','Europe/Rome','EUR',100)",
        [id],
      );
      await db.query(
        "INSERT INTO commercial_policies(id,organization_id,version,commission_bps,refund_cutoff_hours,refund_commission,terms,tax_registration,processing_fee_bearer,payout_model,created_by) VALUES($1,$1,1,1000,0,true,'Historical terms','fixture','seller','stripe-managed',$1)",
        [id],
      );
      await db.query(
        "INSERT INTO ticket_products(id,occurrence_id,name,price_minor,tax_bps,capacity,sale_starts_at,sale_ends_at) VALUES($1,$1,'Old tier',1000,0,100,now(),now()+interval '1 day')",
        [id],
      );
      await db.query(
        "INSERT INTO orders(id,user_id,buyer_email_encrypted,buyer_email_hash,occurrence_id,venue_id,organization_id,policy_id,account_id,currency,total_minor,commission_minor,discount_minor,tax_minor,quantity,snapshot,expires_at) VALUES($1,$1,'encrypted-fixture','fixture',$1,'legacy',$1,$1,'acct_legacy','EUR',3000,300,0,0,3,'{\"immutable\":true}',now()+interval '10 minutes')",
        [id],
      );
      await db.query(
        'INSERT INTO order_lines(id,order_id,product_id,quantity,unit_minor,total_minor,commission_minor,tax_minor,snapshot) VALUES($1,$1,$1,3,1000,3000,300,0,\'{"name":"Old tier"}\')',
        [id],
      );
      const before = (await db.query('SELECT * FROM order_lines WHERE id=$1', [id])).rows[0];
      await migrate(db, source);
      const after = (await db.query('SELECT * FROM order_lines WHERE id=$1', [id])).rows[0];
      expect(after).toEqual({ ...before, admission_count: 3 });
      await expect(db.query('UPDATE order_lines SET quantity=1 WHERE id=$1', [id])).rejects.toThrow();
      expect((await db.query('SELECT snapshot FROM orders WHERE id=$1', [id])).rows[0]!.snapshot).toEqual({
        immutable: true,
      });
    } finally {
      await db.onApplicationShutdown();
      await dispose();
      if (!resolve(folder).startsWith(resolve(tmpdir(), 'clubby-upgrade-')))
        throw new Error('Unsafe temporary path');
      await rm(folder, { recursive: true, force: true });
    }
  },
);
