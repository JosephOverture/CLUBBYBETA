import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';

const configure = createRequire(import.meta.url)('../apps/mobile/app.config.js');
afterEach(() => vi.unstubAllEnvs());
it('rejects insecure or credential-bearing API origins in production native builds', () => {
  vi.stubEnv('CLUBBY_BUILD_ENV', 'production');
  vi.stubEnv('EXPO_PUBLIC_WEB_URL', 'https://clubby.example');
  const config = { plugins: [], ios: {} };
  for (const api of [
    'http://localhost:4100',
    'http://api.clubby.example',
    'https://user:secret@api.clubby.example',
    'https://api.clubby.example/path',
  ]) {
    vi.stubEnv('EXPO_PUBLIC_API_URL', api);
    expect(() => configure({ config })).toThrow('HTTPS origin');
  }
  vi.stubEnv('EXPO_PUBLIC_API_URL', 'https://api.clubby.example');
  expect(configure({ config }).ios.associatedDomains).toEqual(['applinks:clubby.example']);
});
