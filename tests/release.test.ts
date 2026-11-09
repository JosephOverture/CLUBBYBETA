import { describe, it, expect } from 'vitest';
import { releaseChecks, verifyReleaseManifest } from '../apps/api/src/platform/release';
import { readConfig } from '../apps/api/src/platform/config';
import { connectionOptions } from '../apps/api/src/platform/database';

const deployed = {
  APP_ENV: 'production',
  DATABASE_URL: 'postgresql://user:pass@database.example/clubby?sslmode=verify-full',
  WEB_ORIGINS: 'https://clubby.example',
  PUBLIC_API_URL: 'https://api.clubby.example',
};
describe('deployment trust and release activation', () => {
  it('requires all reviewed evidence and binds approval to artifact, origins and a bounded expiry', () => {
    const revision = 'a'.repeat(40),
      now = Date.now();
    const manifest = {
      environment: 'production',
      revision,
      apiOrigin: deployed.PUBLIC_API_URL,
      webOrigins: [deployed.WEB_ORIGINS],
      approvedAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 86400_000).toISOString(),
      checks: Object.fromEntries(
        releaseChecks.map((k) => [
          k,
          { result: 'passed', reviewer: 'test reviewer', evidence: `https://evidence.example/${k}` },
        ]),
      ),
    };
    const verify = (value: unknown, rev = revision) =>
      verifyReleaseManifest(value, rev, deployed.PUBLIC_API_URL, [deployed.WEB_ORIGINS], now);
    expect(verify(manifest).revision).toBe(revision);
    expect(() => verify(manifest, 'b'.repeat(40))).toThrow('does not match');
    expect(() => verify({ ...manifest, checks: {} })).toThrow('incomplete');
    expect(() => verify({ ...manifest, expiresAt: new Date(now - 1).toISOString() })).toThrow('expired');
    expect(() => verify({ ...manifest, expiresAt: new Date(now + 31 * 86400_000).toISOString() })).toThrow();
    expect(() => verify({ ...manifest, webOrigins: ['https://attacker.example'] })).toThrow();
    expect(() => readConfig({ ...deployed, LIVE_COMMERCE: 'true' })).toThrow('release approval');
  });
  it('keeps hostname verification explicit and disallows URL TLS overrides', () => {
    const options = connectionOptions(readConfig(deployed));
    expect(options.connectionString).not.toContain('sslmode');
    expect(options.ssl).toEqual({ rejectUnauthorized: true });
    for (const extra of ['ssl=false', 'sslrootcert=bad', 'uselibpqcompat=true'])
      expect(() => readConfig({ ...deployed, DATABASE_URL: deployed.DATABASE_URL + '&' + extra })).toThrow(
        'TLS',
      );
  });
  it('accepts IAM roles and scoped proxies while rejecting incomplete keys and arbitrary trust', () => {
    const config = readConfig({
      ...deployed,
      STORAGE_MODE: 's3',
      S3_REGION: 'eu-central-1',
      S3_BUCKET: 'private',
      TRUSTED_PROXY_CIDRS: '10.0.1.0/24,10.0.2.0/24',
    });
    expect(config.trustedProxies).toHaveLength(2);
    for (const value of ['true', '0.0.0.0/0', '::/0', '127.0.0.1/33', '10.0.0.0/foo'])
      expect(() => readConfig({ ...deployed, TRUSTED_PROXY_CIDRS: value })).toThrow('proxies');
    expect(() => readConfig({ ...deployed, S3_ACCESS_KEY_ID: 'partial' })).toThrow('complete');
  });
});
