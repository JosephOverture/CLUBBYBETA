import { describe, expect, it } from 'vitest';
import { readConfig } from '../apps/api/src/platform/config';
import { ClubbyClient } from '@clubby/api-client';

const base = { DATABASE_URL: 'postgresql://local:local@127.0.0.1/clubby' };
describe('configuration trust boundaries', () => {
  it('requires complete Apple credentials and an approved HTTPS web redirect', () => {
    expect(() => readConfig({ ...base, APPLE_SIGN_IN_ENABLED: 'true' })).toThrow('Apple sign-in requires');
    expect(() => readConfig({ ...base, OIDC_ISSUER: 'https://appleid.apple.com' })).toThrow(
      'dedicated Apple',
    );
    expect(() => readConfig({ ...base, APPLE_SIGN_IN_REDIRECT_URI: 'https://attacker.example/' })).toThrow(
      'allowed HTTPS',
    );
    expect(() => readConfig({ ...base, APPLE_SIGN_IN_REDIRECT_URI: 'http://localhost:8081/' })).toThrow(
      'allowed HTTPS',
    );
  });
  it('refuses unknown environments, missing databases and partially parsed ports', () => {
    expect(() => readConfig({})).toThrow('DATABASE_URL');
    expect(() => readConfig({ ...base, APP_ENV: 'prod' })).toThrow('APP_ENV');
    expect(() => readConfig({ ...base, PORT: '4100suffix' })).toThrow('PORT');
  });
  it('rejects remote cleartext origins, permissive CORS, public demo binding and premature live commerce', () => {
    for (const extra of [
      { WEB_ORIGINS: '*' },
      { WEB_ORIGINS: 'http://example.com' },
      { HOST: '0.0.0.0' },
      { LIVE_COMMERCE: 'true' },
    ]) {
      expect(() => readConfig({ ...base, ...extra })).toThrow();
    }
  });
  it('requires verified DB TLS in deployed environments without printing secrets', () => {
    expect(() =>
      readConfig({
        ...base,
        APP_ENV: 'production',
        PUBLIC_API_URL: 'https://api.example.com',
        WEB_ORIGINS: 'https://example.com',
      }),
    ).toThrow('sslmode=verify-full');
    expect(() => readConfig({ DATABASE_URL: 'super-secret-invalid-value' })).toThrow(
      'Invalid configuration: DATABASE_URL',
    );
  });
  it('never lets the SDK send credentials to another origin', async () => {
    const client = new ClubbyClient('http://127.0.0.1:4100', { channel: 'ios' });
    await expect(client.request('//example.com/v1/me')).rejects.toThrow('Invalid API path');
    await expect(client.request('/v1/../../private')).rejects.toThrow('Invalid API path');
    expect(() => new ClubbyClient('http://example.com', { channel: 'web' })).toThrow('HTTPS');
  });
});
