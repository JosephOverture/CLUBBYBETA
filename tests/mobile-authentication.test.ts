import { createHash, randomBytes } from 'node:crypto';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const runtime = vi.hoisted(() => ({ platform: 'web', stored: new Map<string, string>() }));
vi.mock('../apps/mobile/node_modules/react-native', () => ({
  Platform: {
    get OS() {
      return runtime.platform;
    },
  },
}));
vi.mock('../apps/mobile/node_modules/expo-secure-store', () => ({
  getItemAsync: async (key: string) => runtime.stored.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    runtime.stored.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    runtime.stored.delete(key);
  },
}));
vi.mock('../apps/mobile/node_modules/expo-crypto', () => ({
  getRandomBytesAsync: async (n: number) => randomBytes(n),
  digestStringAsync: async (_algorithm: string, value: string) =>
    createHash('sha256').update(value).digest('base64'),
  CryptoDigestAlgorithm: { SHA256: 'SHA256' },
  CryptoEncoding: { BASE64: 'BASE64' },
}));
vi.mock('../apps/mobile/src/push-session', () => ({ clearPushDisplay: async () => {} }));
describe('client sign-in and sign-out ordering', () => {
  beforeEach(() => {
    vi.resetModules();
    runtime.platform = 'web';
    runtime.stored.clear();
  });
  afterEach(() => vi.unstubAllGlobals());
  function server() {
    let cookie: string | null = 'old',
      complete: () => void = () => {},
      started: () => void = () => {};
    const requestStarted = new Promise<void>((resolve) => {
        started = resolve;
      }),
      release = new Promise<void>((resolve) => {
        complete = resolve;
      });
    const logoutCsrf: string[] = [];
    vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
      const path = new URL(input).pathname,
        headers = new Headers(init.headers);
      if (path.endsWith('/start'))
        return Response.json({
          data: {
            challengeId: 'challenge',
            nonce: 'nonce',
            state: 'state',
            clientId: 'com.clubby.web',
            redirectURI: 'https://clubby.example.test/',
          },
        });
      if (path.endsWith('/complete')) {
        started();
        await release;
        cookie = 'new';
        return Response.json({
          data: {
            userId: 'new',
            csrfToken: 'csrf-new',
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          },
        });
      }
      if (path === '/v1/auth/logout') {
        if (!cookie) return Response.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 });
        const csrf = headers.get('x-csrf-token');
        logoutCsrf.push(csrf ?? '');
        if (csrf !== `csrf-${cookie}`)
          return Response.json({ error: { code: 'CSRF_INVALID' } }, { status: 403 });
        cookie = null;
        return Response.json({ data: { revoked: true } });
      }
      if (!cookie) return Response.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 });
      if (path === '/v1/auth/session')
        return Response.json({
          data: { id: cookie, email: `${cookie}@example.test`, displayName: cookie, kind: 'registered' },
        });
      if (path === '/v1/auth/csrf') return Response.json({ data: { csrfToken: `csrf-${cookie}` } });
      throw new Error(`Unexpected fixture route ${path}`);
    });
    return { requestStarted, release: complete, logoutCsrf, cookie: () => cookie };
  }
  it('revokes the late Apple cookie before queued sign-out and never returns its profile', async () => {
    const fake = server(),
      session = await import('../apps/mobile/src/session');
    await session.session();
    const start = await session.startAppleSignIn(true),
      completion = session.completeAppleSignIn(start, 'apple-code', start.state);
    const rejected = expect(completion).rejects.toThrow('cancelled');
    await fake.requestStarted;
    const logout = session.signOut();
    fake.release();
    await rejected;
    expect(await logout).toEqual({ remote: true });
    expect(fake.cookie()).toBeNull();
    expect(fake.logoutCsrf).toContain('csrf-new');
  });
  it('rejects a popup completed after sign-out without starting another credential exchange', async () => {
    const fake = server(),
      session = await import('../apps/mobile/src/session');
    await session.session();
    const start = await session.startAppleSignIn(true);
    await session.signOut();
    await expect(session.completeAppleSignIn(start, 'apple-code', start.state)).rejects.toThrow('cancelled');
    expect(fake.cookie()).toBeNull();
  });
  it('applies the same ordering to delayed email completions', async () => {
    const fake = server(),
      session = await import('../apps/mobile/src/session');
    await session.session();
    await session.startSignIn('new@example.test');
    const completion = session.completeSignIn('email-code'),
      rejected = expect(completion).rejects.toThrow('cancelled');
    await fake.requestStarted;
    const logout = session.signOut();
    fake.release();
    await rejected;
    expect(await logout).toEqual({ remote: true });
    expect(fake.cookie()).toBeNull();
  });
  it('revokes late native credentials without restoring them to secure storage after logout', async () => {
    runtime.platform = 'ios';
    runtime.stored.set(
      'clubby.session',
      JSON.stringify({
        userId: 'old',
        token: 'old-token',
        refreshToken: 'old-refresh',
        csrfToken: 'old-csrf',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      }),
    );
    let release: () => void = () => {},
      started: () => void = () => {};
    const wait = new Promise<void>((resolve) => {
        release = resolve;
      }),
      requestStarted = new Promise<void>((resolve) => {
        started = resolve;
      }),
      revoked: string[] = [];
    vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
      const path = new URL(input).pathname,
        headers = new Headers(init.headers);
      if (path.endsWith('/start'))
        return Response.json({
          data: {
            challengeId: 'challenge',
            nonce: 'nonce',
            state: 'state',
            clientId: 'com.clubby.app',
            redirectURI: null,
          },
        });
      if (path.endsWith('/complete')) {
        started();
        await wait;
        return Response.json({
          data: {
            userId: 'new',
            token: 'new-token',
            refreshToken: 'new-refresh',
            csrfToken: 'new-csrf',
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          },
        });
      }
      if (path.endsWith('/logout')) {
        revoked.push(headers.get('authorization')!);
        return Response.json({ data: { revoked: true } });
      }
      throw new Error('Unexpected native fixture request');
    });
    const session = await import('../apps/mobile/src/session'),
      start = await session.startAppleSignIn(true),
      completion = session.completeAppleSignIn(start, 'code', start.state),
      rejected = expect(completion).rejects.toThrow('cancelled');
    await requestStarted;
    const logout = session.signOut();
    release();
    await rejected;
    expect(await logout).toEqual({ remote: true });
    expect(revoked).toEqual(['Bearer new-token', 'Bearer old-token']);
    expect(runtime.stored.has('clubby.session')).toBe(false);
  });
});
