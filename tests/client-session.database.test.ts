import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { ClubbyClient } from '@clubby/api-client';
import { commerceFixture } from './commerce-fixture';
import { IdentityService, type Credentials } from '../apps/api/src/identity/identity.service';
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'shared client session recovery through real HTTP guards',
  () => {
    let f: Awaited<ReturnType<typeof commerceFixture>>;
    beforeAll(async () => {
      f = await commerceFixture();
    });
    afterAll(async () => {
      if (f) await f.close();
    });
    const credentialResponse = z.object({
      data: z.object({
        userId: z.string(),
        token: z.string(),
        csrfToken: z.string(),
        refreshToken: z.string(),
        expiresAt: z.string(),
        channel: z.literal('ios'),
      }),
    });
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const response = await f.app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: (init?.method ?? 'GET') as 'GET'|'POST',
          url: url.pathname + url.search,
          headers: Object.fromEntries(new Headers(init?.headers)),
          ...(init?.body ? { payload: String(init.body) } : {}),
        });
      return new Response(response.body, {
        status: response.statusCode,
        headers: { 'content-type': 'application/json' },
      });
    };
    async function client() {
      const actor = await f.actor();
      let current = actor.credentials;
      const raw = new ClubbyClient('http://127.0.0.1:4100', { channel: 'ios', fetch: transport });
      const refresh = vi.fn(async () => {
        current = credentialResponse.parse(
          await raw.post('/v1/auth/refresh', { refreshToken: current.refreshToken }),
        ).data;
      });
      const options = {
        channel: 'ios' as const,
        fetch: transport,
        authentication: async () => ({
          token: current.token,
          subject: current.userId,
          csrfToken: current.csrfToken,
        }),
        refreshAuthentication: refresh,
      };
      return {
        actor,
        refresh,
        options,
        client: new ClubbyClient('http://127.0.0.1:4100', options),
        set: (v: Credentials) => {
          current = v;
        },
        get: () => current,
      };
    }
    it('shares one refresh across simultaneous expired native reads and a guard-rejected write', async () => {
      const c = await client();
      await f.db.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [
        c.actor.principal.sessionId,
      ]);
      const result = await Promise.all([
        c.client.request('/v1/auth/session'),
        c.client.request('/v1/me/preferences'),
        c.client.request('/v1/orders'),
        c.client.post('/v1/auth/profile', { displayName: 'After session renewal' }),
      ]);
      expect(result).toHaveLength(4);
      expect(c.refresh).toHaveBeenCalledTimes(1);
      expect(
        (
          await f.db.query(
            'SELECT count(*)::int n FROM refresh_tokens WHERE session_id=$1 AND used_at IS NOT NULL',
            [c.actor.principal.sessionId],
          )
        ).rows[0]!.n,
      ).toBe(1);
      expect(
        (await f.db.query('SELECT display_name FROM users WHERE id=$1', [c.actor.principal.userId])).rows[0]!
          .display_name,
      ).toBe('After session renewal');
    });
    it('handles a late response from the old access token without rotating a second refresh token', async () => {
      const c = await client();
      await f.db.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [
        c.actor.principal.sessionId,
      ]);
      let release!: () => void, reached!: () => void;
      const received = new Promise<void>((done) => {
          reached = done;
        }),
        held = new Promise<void>((done) => {
          release = done;
        });
      let delayed = false;
      const fetcher: typeof fetch = async (input, init) => {
        const response = await transport(input, init);
        if (String(input).endsWith('/v1/orders') && !delayed) {
          delayed = true;
          reached();
          await held;
        }
        return response;
      };
      const shared = new ClubbyClient('http://127.0.0.1:4100', { ...c.options, fetch: fetcher });
      const old = shared.request('/v1/orders');
      await received;
      await shared.request('/v1/auth/session');
      release();
      await old;
      expect(c.refresh).toHaveBeenCalledTimes(1);
    });
    it('does not replay an interrupted write, financial denial, or request belonging to another account', async () => {
      const c = await client(),
        fetcher = vi.fn(async () => {
          throw new TypeError('Connection interrupted after sending');
        });
      const disconnected = new ClubbyClient('http://127.0.0.1:4100', { ...c.options, fetch: fetcher });
      await expect(disconnected.post('/v1/auth/profile', { displayName: 'Do not replay' })).rejects.toThrow(
        'interrupted',
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(c.refresh).not.toHaveBeenCalled();
      await expect(c.client.request('/v1/admin/audit')).rejects.toMatchObject({ status: 403 });
      expect(c.refresh).not.toHaveBeenCalled();
      await f.db.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [
        c.actor.principal.sessionId,
      ]);
      const other = await f.actor();
      let changed = false;
      const switched = new ClubbyClient('http://127.0.0.1:4100', {
        ...c.options,
        fetch: async (input, init) => {
          const response = await transport(input, init);
          if (!changed) {
            changed = true;
            c.set(other.credentials);
          }
          return response;
        },
      });
      await expect(switched.post('/v1/auth/profile', { displayName: 'Wrong account' })).rejects.toMatchObject(
        { code: 'SESSION_CHANGED' },
      );
      expect(
        (await f.db.query('SELECT display_name FROM users WHERE id=$1', [other.principal.userId])).rows[0]!
          .display_name,
      ).not.toBe('Wrong account');
    });
    it('rejects responses arriving after logout/account replacement and never loops a revoked refresh family', async () => {
      const c = await client();
      let shared: ClubbyClient;
      shared = new ClubbyClient('http://127.0.0.1:4100', {
        ...c.options,
        fetch: async (input, init) => {
          const response = await transport(input, init);
          shared.invalidateAuthentication();
          return response;
        },
      });
      await expect(shared.request('/v1/auth/session')).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
      await f.app.get(IdentityService).logout(c.actor.principal);
      await expect(c.client.request('/v1/orders')).rejects.toMatchObject({ code: 'INVALID_REFRESH' });
      expect(c.refresh).toHaveBeenCalledTimes(1);
    });
    it('recovers the same CSRF credential in several browser tabs without invalidating prior writes', async () => {
      const actor = await f.actor('web'),
        inject = f.app.getHttpAdapter().getInstance();
      const headers = {
        cookie: `clubby_session=${actor.credentials.token}`,
        origin: 'http://localhost:8081',
      };
      const tabs = await Promise.all([
        inject.inject({ url: '/v1/auth/csrf', headers }),
        inject.inject({ url: '/v1/auth/csrf', headers }),
      ]);
      expect(tabs.map((t: any) => t.json().data.csrfToken)).toEqual([
        actor.credentials.csrfToken,
        actor.credentials.csrfToken,
      ]);
      const write = await inject.inject({
        method: 'POST',
        url: '/v1/auth/profile',
        headers: { ...headers, 'x-csrf-token': actor.credentials.csrfToken },
        payload: { displayName: 'Two browser tabs' },
      });
      expect(write.statusCode).toBe(201);
      const denied = await inject.inject({
        method: 'POST',
        url: '/v1/auth/profile',
        headers: { ...headers, origin: 'https://wrong.example', 'x-csrf-token': actor.credentials.csrfToken },
        payload: { displayName: 'Blocked' },
      });
      expect(denied.statusCode).toBe(403);
    });
  },
);
