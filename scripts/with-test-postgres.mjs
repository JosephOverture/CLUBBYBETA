import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { postgresBinaries } from './postgres-binaries.mjs';

const commands = new Set();
let interrupted = false;
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.once(signal, () => {
  interrupted = true;
  process.exitCode = code;
  for (const child of commands) child.kill('SIGTERM');
});
async function stopOwnedServer(server) {
  if (!server?.pid || server.exitCode !== null || server.signalCode !== null) return;
  await new Promise(done => {
    const timer = setTimeout(() => server.kill('SIGKILL'), 5000);
    server.once('exit', () => { clearTimeout(timer); done(); });
    server.once('error', () => { clearTimeout(timer); done(); });
    server.kill('SIGTERM');
  });
}
function run(executable, args, env = process.env) {
  return new Promise((accept, reject) => {
    if (interrupted && !args.includes('stop')) { reject(new Error('Database tests interrupted.')); return; }
    const child = spawn(executable, args, { windowsHide: true, shell: false, env, stdio: ['ignore', 'pipe', 'pipe'] });
    commands.add(child);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', error => { commands.delete(child); reject(error); });
    child.on('exit', code => { commands.delete(child); code === 0 ? accept(output) : reject(new Error(`Command failed (${code}): ${output}`)); });
  });
}
async function tests(url, binaryDirectory) {
  const selected = process.argv.slice(2);
  if (selected[0] === '--') selected.shift();
  const output = await run(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...selected], {
    ...process.env, APP_ENV: 'test', DATABASE_URL: url, TEST_DATABASE_URL: url, LOG_LEVEL: 'silent',
    ...(binaryDirectory ? {PG_BIN_DIR: process.env.PG_BIN_DIR ?? binaryDirectory} : {}),
  });
  process.stdout.write(output);
}
if (process.env.TEST_DATABASE_URL) {
  // Explicit disposable CI/test database only; never infer one from DATABASE_URL.
  await tests(process.env.TEST_DATABASE_URL);
} else {
  const binaries = await postgresBinaries();
  const directory = await mkdtemp(join(tmpdir(), 'clubby-postgres-test-'));
  const data = join(directory, 'data');
  const password = randomBytes(32).toString('hex');
  const pwfile = join(directory, 'password');
  await writeFile(pwfile, password, { mode: 0o600 });
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(done => probe.close(done));
  let server;
  let started = false;
  let serverError;
  try {
    await run(binaries.initdb, ['-D', data, '-U', 'clubby', '-A', 'scram-sha-256', '--pwfile', pwfile, '--encoding=UTF8', '--locale=C']);
    // All processes are non-windowed, including the server itself. No shell or interactive terminal.
    server = spawn(binaries.postgres, ['-D', data, '-h', '127.0.0.1', '-p', String(port)], {
      windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'],
    });
    server.stderr.on('data', () => {});
    server.on('error', error => { serverError = error; });
    const url = `postgresql://clubby:${password}@127.0.0.1:${port}/postgres`;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (interrupted) throw new Error('Database tests interrupted.');
      if (serverError) throw serverError;
      const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 500 });
      try { await client.connect(); await client.query('SELECT 1'); started = true; }
      catch { /* Server is still starting. */ }
      finally { await client.end().catch(() => {}); }
      if (started) break;
      await delay(250);
    }
    if (!started) throw new Error('Disposable PostgreSQL did not start.');
    console.log('Testing against a disposable PostgreSQL 17 instance (loopback only).');
    await tests(url, binaries.directory);
  } finally {
    if (server && server.exitCode === null && server.signalCode === null && !serverError) {
      try { await run(binaries.pg_ctl, ['-D', data, 'stop', '-m', 'fast', '-w']); }
      catch { /* Fall back to stopping only the exact server spawned above. */ }
      await stopOwnedServer(server);
    }
    if (server?.pid && server.exitCode === null && server.signalCode === null)
      throw new Error('Disposable PostgreSQL is still running; its data directory was preserved.');
    // Resolve and check the exact generated disposable path before any recursive removal.
    const target = resolve(directory);
    const rel = relative(resolve(tmpdir()), target);
    if (!rel.startsWith('clubby-postgres-test-') || rel.includes('..') || isAbsolute(rel)) throw new Error('Unsafe temporary cleanup path.');
    await rm(target, { recursive: true, force: true });
  }
}
