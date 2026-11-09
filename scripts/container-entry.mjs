import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const mode = process.argv[2] ?? 'api';
if (!['api', 'worker', 'migrate', 'rotate-encryption', 'bootstrap-admin', 'import-catalogue'].includes(mode))
  throw new Error('Unknown container command.');
const directory = await mkdtemp(join(tmpdir(), 'clubby-secrets-'));
const env = { ...process.env };
const files = {
  APPLE_SIGN_IN_KEY_PEM: 'APPLE_SIGN_IN_KEY_PATH',
  APPLE_PUSH_KEY_PEM: 'APPLE_PUSH_KEY_PATH',
  APPLE_PASS_CERT_PEM: 'APPLE_PASS_CERT_PATH',
  APPLE_PASS_KEY_PEM: 'APPLE_PASS_KEY_PATH',
  APPLE_WWDR_CERT_PEM: 'APPLE_WWDR_CERT_PATH',
  GOOGLE_WALLET_KEY_PEM: 'GOOGLE_WALLET_KEY_PATH',
  RELEASE_APPROVAL_JSON: 'RELEASE_APPROVAL_PATH',
};
try {
  for (const [source, target] of Object.entries(files)) {
    if (!env[source]) continue;
    const path = join(directory, source);
    await writeFile(path, env[source], { mode: 0o600, flag: 'wx' });
    env[target] = path;
    delete env[source];
    delete process.env[source];
  }
  const child = spawn(process.execPath, [`dist/${mode}.js`, ...process.argv.slice(3)], {
    env,
    stdio: 'inherit',
    windowsHide: true,
    shell: false,
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  process.exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
} finally {
  // Only remove the exact directory allocated above; no configurable deletion target.
  await rm(directory, { recursive: true, force: true });
}
