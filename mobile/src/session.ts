import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { ClubbyClient, ClubbyApiError } from '@clubby/api-client';
import { z } from 'zod';
import { clearPushDisplay } from './push-session';
import { resolveApiOrigin } from './api-origin';

const native = Platform.OS !== 'web';
let csrf: string | undefined;
let authenticationRevision = 0;
let credentialMutation: Promise<void> = Promise.resolve();
function mutateCredentials<T>(action: () => Promise<T>): Promise<T> {
  const next = credentialMutation.then(action);
  credentialMutation = next.then(
    () => {},
    () => {},
  );
  return next;
}
function assertAuthenticationRevision(revision: number) {
  if (revision !== authenticationRevision)
    throw new Error('The sign-in attempt was cancelled because your account changed.');
}
const pendingSchema = z.object({ challengeId: z.string(), verifier: z.string() });
const sessionSchema = z.object({
  data: z.object({
    userId: z.string(),
    csrfToken: z.string(),
    token: z.string().optional(),
    refreshToken: z.string().optional(),
    expiresAt: z.string(),
  }),
});
const profileSchema = z.object({
  data: z.object({
    id: z.string(),
    email: z.string().nullable(),
    displayName: z.string(),
    kind: z.enum(['guest', 'registered']),
  }),
});
export const apiOrigin = resolveApiOrigin(
  process.env.EXPO_PUBLIC_API_URL,
  !native && typeof window !== 'undefined' ? window.location.hostname : undefined,
);
const origin = apiOrigin;
const nativeCredentialsSchema = sessionSchema.shape.data.extend({
  token: z.string(),
  refreshToken: z.string(),
});
type NativeCredentials = z.infer<typeof nativeCredentialsSchema>;
let nativeCredentials: NativeCredentials | null | undefined;
let credentialLoad: Promise<NativeCredentials | null> | undefined;
const authenticationApi = new ClubbyClient(origin, { channel: native ? 'ios' : 'web' });
async function writeNative(data: NativeCredentials) {
  // One secure-store record prevents a crash between separate access/refresh token writes.
  await SecureStore.setItemAsync('clubby.session', JSON.stringify(data));
  nativeCredentials = data;
}
async function readNative(): Promise<NativeCredentials | null> {
  if (nativeCredentials !== undefined) return nativeCredentials;
  if (!credentialLoad)
    credentialLoad = (async () => {
      const value = await SecureStore.getItemAsync('clubby.session');
      if (value) return (nativeCredentials = nativeCredentialsSchema.parse(JSON.parse(value)));
      // Migrate development installations using the former separate secure-store keys once.
      const legacy = await SecureStore.getItemAsync('clubby.refresh');
      if (legacy) {
        let response: z.infer<typeof sessionSchema>;
        try {
          response = sessionSchema.parse(
            await authenticationApi.post('/v1/auth/refresh', { refreshToken: legacy }),
          );
        } catch (error) {
          if (error instanceof ClubbyApiError && error.status === 401) {
            await SecureStore.deleteItemAsync('clubby.access');
            await SecureStore.deleteItemAsync('clubby.refresh');
            return (nativeCredentials = null);
          }
          throw error;
        }
        await writeNative(nativeCredentialsSchema.parse(response.data));
        await SecureStore.deleteItemAsync('clubby.access');
        await SecureStore.deleteItemAsync('clubby.refresh');
        return nativeCredentials!;
      }
      return (nativeCredentials = null);
    })().finally(() => {
      credentialLoad = undefined;
    });
  return credentialLoad;
}
export const api = new ClubbyClient(origin, {
  channel: native ? 'ios' : 'web',
  authentication: async () => {
    const credentials = native ? await readNative() : null;
    return {
      token: credentials?.token,
      csrfToken: csrf ?? credentials?.csrfToken,
      subject: credentials?.userId,
    };
  },
  ...(native
    ? {
        refreshAuthentication: async () => {
          const before = await readNative(),
            revision = authenticationRevision;
          if (!before) throw new Error('Sign in again to continue.');
          const response = sessionSchema.parse(
            await authenticationApi.post('/v1/auth/refresh', { refreshToken: before.refreshToken }),
          );
          const next = nativeCredentialsSchema.parse(response.data);
          if (revision !== authenticationRevision || next.userId !== before.userId)
            throw new Error('The signed-in account changed.');
          await writeNative(next);
          csrf = next.csrfToken;
        },
      }
    : {}),
});
let pending: { challengeId: string; verifier: string } | undefined;
export async function startSignIn(email: string) {
  const revision = authenticationRevision;
  const bytes = await Crypto.getRandomBytesAsync(32);
  const verifier = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, {
    encoding: Crypto.CryptoEncoding.BASE64,
  });
  const challenge = digest.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  const result = z.object({ data: z.object({ challengeId: z.string() }) }).parse(
    await authenticationApi.post('/v1/auth/email/start', {
      email,
      channel: native ? 'ios' : 'web',
      challenge,
    }),
  );
  assertAuthenticationRevision(revision);
  pending = { challengeId: result.data.challengeId, verifier };
  if (native) await SecureStore.setItemAsync('clubby.pending-login', JSON.stringify(pending));
}
async function save(value: unknown) {
  const { data } = sessionSchema.parse(value);
  csrf = data.csrfToken;
  if (native && data.token && data.refreshToken) {
    await writeNative(nativeCredentialsSchema.parse(data));
    await SecureStore.deleteItemAsync('clubby.access');
    await SecureStore.deleteItemAsync('clubby.refresh');
  }
}
export async function completeSignIn(token: string) {
  const revision = authenticationRevision;
  if (native && !pending) {
    const value = await SecureStore.getItemAsync('clubby.pending-login');
    if (value) pending = pendingSchema.parse(JSON.parse(value));
  }
  if (!pending) throw new Error('Request a new sign-in code.');
  const input = { ...pending, token: token.trim() };
  return completeCredentials(revision, () => authenticationApi.post('/v1/auth/email/complete', input));
}
export async function startAppleSignIn(link = false) {
  const revision = authenticationRevision;
  const bytes = await Crypto.getRandomBytesAsync(32),
    verifier = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, {
    encoding: Crypto.CryptoEncoding.BASE64,
  });
  const result = z
    .object({
      data: z.object({
        challengeId: z.string(),
        nonce: z.string(),
        state: z.string(),
        clientId: z.string(),
        redirectURI: z.string().nullable(),
      }),
    })
    .parse(
      await (link ? api : authenticationApi).post(`/v1/auth/apple/${link ? 'link/' : ''}start`, {
        channel: native ? 'ios' : 'web',
        challenge: digest.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''),
      }),
    );
  assertAuthenticationRevision(revision);
  return { ...result.data, verifier, link, revision };
}
export async function completeAppleSignIn(
  start: Awaited<ReturnType<typeof startAppleSignIn>>,
  code: string,
  state: string,
) {
  if (state !== start.state) throw new Error('Apple sign-in state did not match. Try again.');
  const linkingApi = new ClubbyClient(origin, {
    channel: native ? 'ios' : 'web',
    accessToken: async () => (native ? (await readNative())?.token : undefined),
    csrfToken: async () => csrf ?? (native ? (await readNative())?.csrfToken : undefined),
  });
  return completeCredentials(start.revision, () =>
    (start.link ? linkingApi : authenticationApi).post(
      `/v1/auth/apple/${start.link ? 'link/' : ''}complete`,
      {
        challengeId: start.challengeId,
        verifier: start.verifier,
        state,
        code,
      },
    ),
  );
}
async function completeCredentials(revision: number, request: () => Promise<unknown>) {
  return mutateCredentials(async () => {
    assertAuthenticationRevision(revision);
    const activeRevision = ++authenticationRevision;
    api.invalidateAuthentication();
    const response = await request();
    const rejectStale = async () => {
      if (activeRevision === authenticationRevision) return;
      const { data } = sessionSchema.parse(response);
      // A late response can already have set a browser cookie. Revoke that issued session before
      // queued logout/account writes proceed, and never publish its profile to the screen.
      const issued = new ClubbyClient(origin, {
        channel: native ? 'ios' : 'web',
        accessToken: async () => data.token,
        csrfToken: async () => data.csrfToken,
      });
      await issued.post('/v1/auth/logout', { all: false }).catch(() => {});
      assertAuthenticationRevision(activeRevision);
    };
    await rejectStale();
    await save(response);
    pending = undefined;
    if (native) await SecureStore.deleteItemAsync('clubby.pending-login');
    await rejectStale();
    const profile = await session();
    await rejectStale();
    return profile;
  });
}
export async function session() {
  const result = profileSchema.parse(await api.request('/v1/auth/session'));
  if (!native)
    csrf = z.object({ data: z.object({ csrfToken: z.string() }) }).parse(await api.request('/v1/auth/csrf'))
      .data.csrfToken;
  return result.data;
}
export async function signOut() {
  authenticationRevision++;
  api.invalidateAuthentication();
  return mutateCredentials(async () => {
    let remote = true;
    try {
      await api.post('/v1/auth/logout', { all: false });
    } catch (error) {
      remote = error instanceof ClubbyApiError && error.status === 401;
    }
    await clearPushDisplay().catch(() => {});
    csrf = undefined;
    pending = undefined;
    if (native) {
      nativeCredentials = null;
      await SecureStore.deleteItemAsync('clubby.session');
      await SecureStore.deleteItemAsync('clubby.access');
      await SecureStore.deleteItemAsync('clubby.refresh');
      await SecureStore.deleteItemAsync('clubby.pending-login');
    }
    return { remote };
  });
}
