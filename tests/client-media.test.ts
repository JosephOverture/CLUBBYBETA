import { describe, it, expect, vi } from 'vitest';
import { ClubbyClient } from '@clubby/api-client';
import { resolveApiOrigin } from '../apps/mobile/src/api-origin';
describe('authenticated media transport', () => {
  it('keeps local web API calls on the frontend cookie site and preserves explicit deployments', () => {
    expect(resolveApiOrigin(undefined, 'localhost')).toBe('http://localhost:4100');
    expect(resolveApiOrigin(undefined, '127.0.0.1')).toBe('http://127.0.0.1:4100');
    expect(resolveApiOrigin('https://api.clubby.example', 'localhost')).toBe('https://api.clubby.example');
    expect(resolveApiOrigin(undefined)).toBe('http://127.0.0.1:4100');
  });
  it('preserves image bytes, authenticates previews and recovers an expired read once', async () => {
    let token = 'expired';
    const refresh = vi.fn(async () => {
      token = 'renewed';
    });
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
      if (token === 'expired')
        return Response.json({ error: { code: 'UNAUTHENTICATED', message: 'Expired' } }, { status: 401 });
      return new Response(new Uint8Array([0, 255, 17, 128]), { headers: { 'content-type': 'image/webp' } });
    });
    const client = new ClubbyClient('http://127.0.0.1:4100', {
      channel: 'ios',
      authentication: async () => ({ token, subject: 'seller' }),
      refreshAuthentication: refresh,
      fetch: fetcher,
    });
    const blob = await client.blob('/v1/media/example/preview/thumbnail');
    expect(blob.type).toBe('image/webp');
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([0, 255, 17, 128]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects private image responses after logout and reports JSON authorization failures', async () => {
    let client: ClubbyClient;
    client = new ClubbyClient('http://127.0.0.1:4100', {
      channel: 'web',
      fetch: async () => {
        client.invalidateAuthentication();
        return new Response('private image');
      },
    });
    await expect(client.blob('/v1/media/example/preview/thumbnail')).rejects.toMatchObject({
      code: 'SESSION_CHANGED',
    });
    const denied = new ClubbyClient('http://127.0.0.1:4100', {
      channel: 'ios',
      fetch: async () =>
        Response.json({ error: { code: 'FORBIDDEN', message: 'No access' } }, { status: 403 }),
    });
    await expect(denied.blob('/v1/media/example/preview/thumbnail')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
  });
  it('never replays binary writes after a guard failure', async () => {
    const refresh = vi.fn(),
      body = new Blob(['image']);
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.body).toBe(body);
      return Response.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 });
    });
    const client = new ClubbyClient('http://127.0.0.1:4100', {
      channel: 'ios',
      authentication: async () => ({ token: 'old', subject: 'seller' }),
      refreshAuthentication: refresh,
      fetch: fetcher,
    });
    await expect(client.request('/v1/media/example/content', { method: 'PUT', body })).rejects.toMatchObject({
      status: 401,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });
});
