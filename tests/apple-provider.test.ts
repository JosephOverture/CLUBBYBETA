import { randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { generateKeyPair, exportPKCS8, exportJWK, createLocalJWKSet, SignJWT, jwtVerify } from 'jose';
import { AppleIdentityProvider, appleIssuer } from '../apps/api/src/identity/apple-provider';
import { readConfig } from '../apps/api/src/platform/config';
describe('Apple OAuth signing and token validation', () => {
  let developer: Awaited<ReturnType<typeof generateKeyPair>>,
    apple: Awaited<ReturnType<typeof generateKeyPair>>,
    provider: AppleIdentityProvider;
  const keyPath = join(tmpdir(), `clubby-apple-signing-${randomUUID()}.p8`),
    forms: URLSearchParams[] = [];
  let audience = 'com.clubby.app',
    nonce = 'expected-nonce',
    issuer = appleIssuer,
    status = 200,
    revocationStatus = 200,
    verified: unknown = 'true';
  beforeAll(async () => {
    developer = await generateKeyPair('ES256', { extractable: true });
    apple = await generateKeyPair('RS256');
    await writeFile(keyPath, await exportPKCS8(developer.privateKey), { mode: 0o600 });
    const config = readConfig({
      DATABASE_URL: 'postgresql://localhost/unused',
      APPLE_SIGN_IN_ENABLED: 'true',
      APPLE_TEAM_ID: 'TEAM123456',
      APPLE_SIGN_IN_KEY_ID: 'KEY1234567',
      APPLE_SIGN_IN_KEY_PATH: keyPath,
      APPLE_SIGN_IN_WEB_CLIENT_ID: 'com.clubby.web',
      APPLE_SIGN_IN_IOS_CLIENT_ID: 'com.clubby.app',
      APPLE_SIGN_IN_REDIRECT_URI: 'https://clubby.example.test/',
      WEB_ORIGINS: 'https://clubby.example.test',
      APP_ENCRYPTION_KEY: 'ab'.repeat(32),
    });
    const transport: typeof fetch = async (url, init) => {
      const form = new URLSearchParams(String(init?.body));
      forms.push(form);
      const claims = await jwtVerify(form.get('client_secret')!, developer.publicKey, {
        issuer: 'TEAM123456',
        audience: appleIssuer,
        subject: form.get('client_id')!,
        algorithms: ['ES256'],
      });
      expect(claims.protectedHeader.kid).toBe('KEY1234567');
      expect(claims.payload.exp! - claims.payload.iat!).toBe(300);
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeDefined();
      if (String(url).endsWith('/revoke')) return new Response('', { status: revocationStatus });
      const token = await new SignJWT({
        nonce,
        email: 'Relay@privaterelay.appleid.com',
        email_verified: verified,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'apple-key' })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject('apple-subject')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(apple.privateKey);
      return Response.json(
        { id_token: token, refresh_token: 'provider-refresh-secret', token_type: 'Bearer' },
        { status },
      );
    };
    provider = new AppleIdentityProvider(
      config,
      transport,
      createLocalJWKSet({
        keys: [{ ...(await exportJWK(apple.publicKey)), kid: 'apple-key', alg: 'RS256' }],
      }),
    );
  });
  afterAll(async () => {
    await unlink(keyPath);
  });
  it('exchanges native codes with a signed client secret and accepts Apple string-valued verified claims', async () => {
    const result = await provider.authenticate('native-code', 'ios', 'expected-nonce');
    expect(result).toMatchObject({
      subject: 'apple-subject',
      email: 'relay@privaterelay.appleid.com',
      verified: true,
    });
    expect(forms.at(-1)!.get('client_id')).toBe('com.clubby.app');
    expect(forms.at(-1)!.has('redirect_uri')).toBe(false);
    expect(forms.at(-1)!.get('grant_type')).toBe('authorization_code');
  });
  it('binds web authorization codes to the registered Services ID and redirect URI', async () => {
    audience = 'com.clubby.web';
    await provider.authenticate('web-code', 'web', 'expected-nonce');
    expect(forms.at(-1)!.get('redirect_uri')).toBe('https://clubby.example.test/');
    audience = 'com.clubby.app';
  });
  it('rejects wrong audience, nonce and issuer and never treats string false as verified', async () => {
    audience = 'other-app';
    await expect(provider.authenticate('code', 'ios', 'expected-nonce')).rejects.toMatchObject({
      code: 'INVALID_CREDENTIAL',
    });
    audience = 'com.clubby.app';
    nonce = 'other-nonce';
    await expect(provider.authenticate('code', 'ios', 'expected-nonce')).rejects.toMatchObject({
      code: 'INVALID_CREDENTIAL',
    });
    nonce = 'expected-nonce';
    issuer = 'https://attacker.example';
    await expect(provider.authenticate('code', 'ios', 'expected-nonce')).rejects.toMatchObject({
      code: 'INVALID_CREDENTIAL',
    });
    issuer = appleIssuer;
    verified = 'false';
    expect((await provider.authenticate('code', 'ios', 'expected-nonce')).verified).toBe(false);
    verified = 'true';
  });
  it('revokes using the stored refresh token, retries non-200 outcomes and accepts repeat success', async () => {
    revocationStatus = 500;
    await expect(provider.revoke('com.clubby.app', 'stored-token')).rejects.toThrow('did not complete');
    revocationStatus = 200;
    await provider.revoke('com.clubby.app', 'stored-token');
    await provider.revoke('com.clubby.app', 'stored-token');
    expect(forms.at(-1)!.get('token_type_hint')).toBe('refresh_token');
    expect(forms.at(-1)!.get('token')).toBe('stored-token');
    status = 400;
    await expect(provider.authenticate('consumed-code', 'ios', 'expected-nonce')).rejects.toMatchObject({
      code: 'INVALID_CREDENTIAL',
    });
    status = 200;
  });
});
