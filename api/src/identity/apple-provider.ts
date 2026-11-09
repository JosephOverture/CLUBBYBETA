import { readFile } from 'node:fs/promises';
import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import type { Config } from '../platform/config';
import { ApiError } from '../platform/http';
export const appleIssuer = 'https://appleid.apple.com';
export type AppleIdentity = {
  subject: string;
  email?: string;
  verified: boolean;
  refreshToken: string;
  authenticatedAt?: number;
};
export interface AppleProvider {
  authenticate(code: string, channel: 'web' | 'ios', nonce: string): Promise<AppleIdentity>;
  revoke(clientId: string, refreshToken: string): Promise<void>;
}
export class AppleIdentityProvider implements AppleProvider {
  private jwks: JWTVerifyGetKey;
  constructor(
    readonly config: Config,
    readonly transport: typeof fetch = fetch,
    jwks?: JWTVerifyGetKey,
  ) {
    this.jwks = jwks ?? createRemoteJWKSet(new URL(`${appleIssuer}/auth/keys`), { timeoutDuration: 5000 });
  }
  private async clientSecret(clientId: string) {
    if (
      !this.config.APPLE_SIGN_IN_KEY_PATH ||
      !this.config.APPLE_SIGN_IN_KEY_ID ||
      !this.config.APPLE_TEAM_ID
    )
      throw new ApiError('NOT_CONFIGURED', 'Apple identity credentials are not configured.', 503);
    const key = await importPKCS8(await readFile(this.config.APPLE_SIGN_IN_KEY_PATH, 'utf8'), 'ES256');
    return new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: this.config.APPLE_SIGN_IN_KEY_ID })
      .setIssuer(this.config.APPLE_TEAM_ID)
      .setAudience(appleIssuer)
      .setSubject(clientId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key);
  }
  async authenticate(code: string, channel: 'web' | 'ios', nonce: string): Promise<AppleIdentity> {
    const clientId =
      channel === 'web' ? this.config.APPLE_SIGN_IN_WEB_CLIENT_ID : this.config.APPLE_SIGN_IN_IOS_CLIENT_ID;
    if (!clientId || this.config.APPLE_SIGN_IN_ENABLED !== 'true')
      throw new ApiError('NOT_CONFIGURED', 'Sign in with Apple is not available.', 503);
    const form = new URLSearchParams({
      client_id: clientId,
      client_secret: await this.clientSecret(clientId),
      code,
      grant_type: 'authorization_code',
    });
    if (channel === 'web') form.set('redirect_uri', this.config.APPLE_SIGN_IN_REDIRECT_URI!);
    let response: Response;
    try {
      response = await this.transport(`${appleIssuer}/auth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ApiError(
        'IDENTITY_UNAVAILABLE',
        'Apple sign-in could not be completed. Start a new sign-in attempt.',
        503,
      );
    }
    if (!response.ok)
      throw new ApiError(
        response.status >= 500 ? 'IDENTITY_UNAVAILABLE' : 'INVALID_CREDENTIAL',
        'Apple sign-in could not be completed. Start a new sign-in attempt.',
        response.status >= 500 ? 503 : 401,
      );
    const tokens = z
      .object({
        id_token: z.string().min(20).max(20000),
        refresh_token: z.string().min(1).max(10000),
        token_type: z.literal('Bearer'),
      })
      .safeParse(await response.json());
    if (!tokens.success)
      throw new ApiError('INVALID_CREDENTIAL', 'Apple returned an incomplete credential.', 401);
    try {
      const { payload } = await jwtVerify(tokens.data.id_token, this.jwks, {
        issuer: appleIssuer,
        audience: clientId,
        algorithms: ['RS256'],
        requiredClaims: ['sub', 'iat', 'exp', 'nonce'],
        maxTokenAge: '10m',
      });
      if (payload.nonce !== nonce || !payload.sub) throw new Error('Invalid nonce');
      const email = z.string().email().max(254).safeParse(payload.email);
      return {
        subject: payload.sub,
        email: email.success ? email.data.toLowerCase() : undefined,
        verified: payload.email_verified === true || payload.email_verified === 'true',
        refreshToken: tokens.data.refresh_token,
        authenticatedAt: payload.iat,
      };
    } catch {
      throw new ApiError('INVALID_CREDENTIAL', 'Apple identity token is invalid.', 401);
    }
  }
  async revoke(clientId: string, refreshToken: string) {
    const response = await this.transport(`${appleIssuer}/auth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: await this.clientSecret(clientId),
        token: refreshToken,
        token_type_hint: 'refresh_token',
      }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    // Apple returns 200 for tokens already revoked. Other errors are retried; never claim deletion succeeded.
    if (response.status !== 200) throw new Error('Apple token revocation did not complete.');
  }
}
