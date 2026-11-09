import { randomUUID } from 'node:crypto';
import { createServer, connect, type IncomingHttpHeaders } from 'node:http2';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { generateKeyPair, exportPKCS8, jwtVerify } from 'jose';
import { it, expect } from 'vitest';
import { ApnsProvider } from '../apps/api/src/notifications/push-provider';
import { readConfig } from '../apps/api/src/platform/config';
it('sends a signed APNs HTTP/2 request with private payloads and distinguishes stale tokens from retryable failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clubby-apns-test-'));
  const server = createServer(),
    requests: { headers: IncomingHttpHeaders; body: string }[] = [];
  let status = 200;
  server.on('stream', (stream, headers) => {
    let body = '';
    stream.on('data', (chunk) => {
      body += chunk;
    });
    stream.on('end', () => {
      requests.push({ headers, body });
      stream.respond({ ':status': status, 'content-type': 'application/json' });
      stream.end(
        status === 200
          ? ''
          : JSON.stringify({ reason: status === 410 ? 'Unregistered' : 'InternalServerError' }),
      );
    });
  });
  try {
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    const path = join(directory, 'key.p8');
    await writeFile(path, await exportPKCS8(privateKey), { mode: 0o600 });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No loopback port');
    const endpoints: string[] = [];
    const provider = new ApnsProvider(
      readConfig({
        APP_ENV: 'test',
        DATABASE_URL: 'postgresql://unused/unused',
        APP_ENCRYPTION_KEY: 'f1'.repeat(32),
        APPLE_PUSH_ENABLED: 'true',
        APPLE_TEAM_ID: 'TESTTEAM01',
        APPLE_PUSH_KEY_ID: 'TESTKEY001',
        APPLE_PUSH_KEY_PATH: path,
        APPLE_PUSH_BUNDLE_ID: 'com.clubby.test',
      }),
      ((authority) => {
        endpoints.push(String(authority));
        return connect(`http://127.0.0.1:${address.port}`);
      }) as typeof connect,
    );
    const notification = randomUUID(),
      delivery = randomUUID(),
      token = 'ab'.repeat(32);
    expect(await provider.send(token, notification, delivery)).toBe('sent');
    const req = requests[0]!,
      authorization = String(req.headers.authorization).replace(/^bearer /, '');
    const jwt = await jwtVerify(authorization, publicKey, {
      issuer: 'TESTTEAM01',
      algorithms: ['ES256'],
      maxTokenAge: '1 hour',
    });
    expect(jwt.protectedHeader.kid).toBe('TESTKEY001');
    expect(req.headers[':path']).toBe(`/3/device/${token}`);
    expect(req.headers['apns-topic']).toBe('com.clubby.test');
    expect(req.headers['apns-push-type']).toBe('alert');
    expect(req.headers['apns-id']).toBe(delivery);
    expect(req.headers['apns-collapse-id']).toBe(notification);
    expect(JSON.parse(req.body)).toEqual({
      aps: { alert: { title: 'Clubby', body: 'You have a new update in Clubby.' }, sound: 'default' },
      notificationId: notification,
    });
    expect(endpoints[0]).toBe('https://api.sandbox.push.apple.com');
    status = 410;
    expect(await provider.send(token, notification, randomUUID())).toBe('unregistered');
    status = 500;
    await expect(provider.send(token, notification, randomUUID())).rejects.toThrow('500');
    expect(requests[1]!.headers.authorization).toBe(req.headers.authorization);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    const target = resolve(directory),
      rel = relative(resolve(tmpdir()), target);
    if (isAbsolute(rel) || !rel.startsWith('clubby-apns-test-') || rel.includes('..'))
      throw new Error('Unsafe temporary cleanup path');
    await rm(target, { recursive: true, force: true });
  }
});
