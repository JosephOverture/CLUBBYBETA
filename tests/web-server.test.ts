import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error Node deployment module is intentionally standalone JavaScript.
import { websiteServer } from '../scripts/web-server.mjs';
describe('production website host', () => {
  it('serves navigation and association while rejecting secret paths, missing assets and unsafe methods', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clubby-web-test-'));
    await writeFile(join(root, 'index.html'), '<html>Clubby</html>');
    await writeFile(join(root, '.env'), 'secret');
    const association = { applinks: { details: [] } },
      server = websiteServer(root, 'https://api.example.test', association);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
      const response = await fetch(origin + '/bookings/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('Clubby');
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      for (const path of ['/.env', '/%2eenv', '/missing.js', '/bundle.map', '/random-route'])
        expect((await fetch(origin + path)).status).toBe(404);
      expect((await fetch(origin, { method: 'POST' })).status).toBe(405);
      expect((await fetch(origin, { method: 'HEAD' })).status).toBe(200);
      expect(await (await fetch(origin + '/.well-known/apple-app-site-association')).json()).toEqual(
        association,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  });
});
