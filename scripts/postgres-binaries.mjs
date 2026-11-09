import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function postgresBinaries() {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  let binaries;
  if (process.env.PG_BIN_DIR) {
    binaries = Object.fromEntries(['initdb','postgres','pg_ctl'].map(name => [name,join(process.env.PG_BIN_DIR,name+suffix)]));
  } else {
    const packages = {'darwin-arm64':'@embedded-postgres/darwin-arm64','win32-x64':'@embedded-postgres/windows-x64'};
    const packageName = packages[`${process.platform}-${process.arch}`];
    if (!packageName) throw new Error('Set PG_BIN_DIR to PostgreSQL 17 binaries, or DATABASE_URL to a local PostgreSQL database.');
    try { binaries = await import(packageName); }
    catch { throw new Error(`Install optional dependencies (${packageName}), or set PG_BIN_DIR to PostgreSQL 17 binaries.`); }
  }
  for (const name of ['initdb','postgres','pg_ctl']) {
    if (typeof binaries[name] !== 'string') throw new Error(`PostgreSQL binary unavailable: ${name}`);
    await access(binaries[name]);
  }
  return {initdb:binaries.initdb,postgres:binaries.postgres,pg_ctl:binaries.pg_ctl,directory:dirname(binaries.pg_ctl)};
}
