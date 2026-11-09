import { z } from 'zod';
import { isIP } from 'node:net';
import { readReleaseManifest } from './release';

const schema = z.object({
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(4101),
  HTTP_RATE_LIMIT: z.coerce.number().int().min(30).max(10000).default(120),
  DATABASE_URL: z.string().url(),
  DATABASE_CA_PATH: z.string().min(1).optional(),
  TRUSTED_PROXY_CIDRS: z.string().default(''),
  RELEASE_APPROVAL_PATH: z.string().min(1).optional(),
  RELEASE_REVISION: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .optional(),
  WEB_ORIGINS: z.string().default('http://localhost:8081,http://127.0.0.1:8081'),
  PUBLIC_API_URL: z.string().url().default('http://127.0.0.1:4100'),
  LIVE_COMMERCE: z.enum(['true', 'false']).default('false'),
  STRIPE_MODE: z.enum(['disabled', 'test', 'live']).default('disabled'),
  STRIPE_SECRET_KEY: z
    .string()
    .regex(/^sk_(test|live)_/)
    .optional(),
  STRIPE_PUBLISHABLE_KEY: z
    .string()
    .regex(/^pk_(test|live)_/)
    .optional(),
  STRIPE_WEBHOOK_SECRETS: z.string().optional(),
  STRIPE_ONBOARDING_ORIGIN: z.string().url().optional(),
  LOG_LEVEL: z.enum(['silent', 'error', 'warn', 'info', 'debug']).default('info'),
  APP_ENCRYPTION_KEY: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .optional(),
  APP_ENCRYPTION_PREVIOUS_KEYS: z.string().default(''),
  EMAIL_MODE: z.enum(['disabled', 'file', 'resend']).default('disabled'),
  EMAIL_FROM: z.string().email().optional(),
  RESEND_API_KEY: z.string().min(10).optional(),
  RESEND_WEBHOOK_SECRETS: z.string().optional(),
  APPLE_PUSH_ENABLED: z.enum(['true', 'false']).default('false'),
  APPLE_PUSH_KEY_ID: z
    .string()
    .regex(/^[A-Z0-9]{10}$/)
    .optional(),
  APPLE_PUSH_KEY_PATH: z.string().optional(),
  APPLE_PUSH_BUNDLE_ID: z
    .string()
    .regex(/^[A-Za-z0-9.-]+$/)
    .optional(),
  APPLE_PUSH_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_AUDIENCE: z.string().min(1).optional(),
  OIDC_JWKS_URL: z.string().url().optional(),
  APPLE_SIGN_IN_ENABLED: z.enum(['true', 'false']).default('false'),
  APPLE_SIGN_IN_KEY_ID: z
    .string()
    .regex(/^[A-Z0-9]{10}$/)
    .optional(),
  APPLE_SIGN_IN_KEY_PATH: z.string().optional(),
  APPLE_SIGN_IN_WEB_CLIENT_ID: z
    .string()
    .regex(/^[A-Za-z0-9.-]+$/)
    .optional(),
  APPLE_SIGN_IN_IOS_CLIENT_ID: z
    .string()
    .regex(/^[A-Za-z0-9.-]+$/)
    .optional(),
  APPLE_SIGN_IN_REDIRECT_URI: z.string().url().optional(),
  STORAGE_MODE: z.enum(['disabled', 'file', 's3']).default('disabled'),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_SESSION_TOKEN: z.string().optional(),
  APPLE_WALLET_ENABLED: z.enum(['true', 'false']).default('false'),
  APPLE_PASS_TYPE_ID: z
    .string()
    .regex(/^pass\.[A-Za-z0-9.-]+$/)
    .optional(),
  APPLE_TEAM_ID: z
    .string()
    .regex(/^[A-Z0-9]{10}$/)
    .optional(),
  APPLE_PASS_CERT_PATH: z.string().optional(),
  APPLE_PASS_KEY_PATH: z.string().optional(),
  APPLE_WWDR_CERT_PATH: z.string().optional(),
  APPLE_PASS_KEY_PASSPHRASE: z.string().optional(),
  GOOGLE_WALLET_ENABLED: z.enum(['true', 'false']).default('false'),
  GOOGLE_WALLET_ISSUER_ID: z.string().regex(/^\d+$/).optional(),
  GOOGLE_WALLET_CLIENT_EMAIL: z.string().email().optional(),
  GOOGLE_WALLET_KEY_PATH: z.string().optional(),
});
export type Config = Readonly<
  z.infer<typeof schema> & { webOrigins: string[]; trustedProxies: string[]; encryptionKeys: string[] }
>;
export const CONFIG = Symbol('CONFIG');
export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success)
    throw new Error(`Invalid configuration: ${result.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  const config = result.data;
  if (config.OIDC_ISSUER === 'https://appleid.apple.com')
    throw new Error('Use the dedicated Apple sign-in adapter so deletion can revoke provider tokens.');
  if (
    config.APPLE_SIGN_IN_ENABLED === 'true' &&
    (!config.APPLE_TEAM_ID ||
      !config.APPLE_SIGN_IN_KEY_ID ||
      !config.APPLE_SIGN_IN_KEY_PATH ||
      !config.APPLE_SIGN_IN_WEB_CLIENT_ID ||
      !config.APPLE_SIGN_IN_IOS_CLIENT_ID ||
      !config.APPLE_SIGN_IN_REDIRECT_URI ||
      !config.APP_ENCRYPTION_KEY)
  )
    throw new Error(
      'Apple sign-in requires web/iOS client IDs, team/key credentials, redirect URI and encryption.',
    );
  if (config.APPLE_SIGN_IN_REDIRECT_URI) {
    const redirect = new URL(config.APPLE_SIGN_IN_REDIRECT_URI);
    if (
      redirect.protocol !== 'https:' ||
      redirect.username ||
      redirect.password ||
      redirect.hash ||
      redirect.search ||
      !config.WEB_ORIGINS.split(',')
        .map((v) => v.trim())
        .includes(redirect.origin)
    )
      throw new Error(
        'Apple sign-in redirect must use an allowed HTTPS website origin without query or credentials.',
      );
  }
  if (
    config.APPLE_PUSH_ENABLED === 'true' &&
    (!config.APPLE_TEAM_ID ||
      !config.APPLE_PUSH_KEY_ID ||
      !config.APPLE_PUSH_KEY_PATH ||
      !config.APPLE_PUSH_BUNDLE_ID ||
      !config.APP_ENCRYPTION_KEY)
  )
    throw new Error('iOS push requires team/key/bundle credentials and encryption.');
  if (
    config.APP_ENV === 'production' &&
    config.APPLE_PUSH_ENABLED === 'true' &&
    config.APPLE_PUSH_ENVIRONMENT !== 'production'
  )
    throw new Error('Production push requires the production APNs environment.');
  if (
    config.APPLE_WALLET_ENABLED === 'true' &&
    (!config.APP_ENCRYPTION_KEY ||
      !config.APPLE_PASS_TYPE_ID ||
      !config.APPLE_TEAM_ID ||
      !config.APPLE_PASS_CERT_PATH ||
      !config.APPLE_PASS_KEY_PATH ||
      !config.APPLE_WWDR_CERT_PATH ||
      !config.PUBLIC_API_URL.startsWith('https://'))
  )
    throw new Error('Apple Wallet requires signing credentials, encryption and a public HTTPS origin.');
  if (
    config.GOOGLE_WALLET_ENABLED === 'true' &&
    (!config.APP_ENCRYPTION_KEY ||
      !config.GOOGLE_WALLET_ISSUER_ID ||
      !config.GOOGLE_WALLET_CLIENT_EMAIL ||
      !config.GOOGLE_WALLET_KEY_PATH)
  )
    throw new Error('Google Wallet requires issuer credentials and encryption.');
  const db = new URL(config.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(db.protocol))
    throw new Error('DATABASE_URL must use PostgreSQL.');
  const local = ['development', 'test'].includes(config.APP_ENV);
  if (config.STRIPE_MODE !== 'disabled') {
    if (
      !config.STRIPE_SECRET_KEY?.startsWith(`sk_${config.STRIPE_MODE}_`) ||
      !config.STRIPE_PUBLISHABLE_KEY?.startsWith(`pk_${config.STRIPE_MODE}_`) ||
      !config.APP_ENCRYPTION_KEY ||
      !config.STRIPE_WEBHOOK_SECRETS?.split(',').every((s) => /^whsec_[A-Za-z0-9]+$/.test(s))
    )
      throw new Error('Stripe mode requires matching keys, webhook secrets and encryption.');
    if (config.STRIPE_MODE === 'live' && (local || config.LIVE_COMMERCE !== 'true'))
      throw new Error('Live Stripe requires a deployed, explicitly enabled commerce environment.');
    if (
      !config.STRIPE_ONBOARDING_ORIGIN ||
      !config.WEB_ORIGINS.split(',')
        .map((s) => s.trim())
        .includes(config.STRIPE_ONBOARDING_ORIGIN)
    )
      throw new Error('Stripe onboarding must return to an allowed website origin.');
  }
  if (!local && config.EMAIL_MODE === 'file')
    throw new Error('Development email delivery cannot be deployed.');
  if (!local && config.STORAGE_MODE === 'file')
    throw new Error('Development file storage cannot be deployed.');
  if (config.STORAGE_MODE === 's3' && (!config.S3_REGION || !config.S3_BUCKET))
    throw new Error('S3 region and bucket are required.');
  if (
    Boolean(config.S3_ACCESS_KEY_ID) !== Boolean(config.S3_SECRET_ACCESS_KEY) ||
    (config.S3_SESSION_TOKEN && !config.S3_ACCESS_KEY_ID)
  )
    throw new Error('S3 explicit credentials must be complete; otherwise use the workload IAM role.');
  if (config.EMAIL_MODE !== 'disabled' && !config.APP_ENCRYPTION_KEY)
    throw new Error('APP_ENCRYPTION_KEY is required for identity delivery.');
  if (config.EMAIL_MODE === 'resend' && (!config.RESEND_API_KEY || !config.EMAIL_FROM))
    throw new Error('Resend credentials and sender are required.');
  const oidc = [config.OIDC_ISSUER, config.OIDC_AUDIENCE, config.OIDC_JWKS_URL];
  if (
    oidc.some(Boolean) &&
    (!oidc.every(Boolean) ||
      !config.OIDC_ISSUER?.startsWith('https://') ||
      !config.OIDC_JWKS_URL?.startsWith('https://'))
  )
    throw new Error('OIDC requires an HTTPS issuer/JWKS and an audience.');
  const origins = config.WEB_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const origin of [...origins, config.PUBLIC_API_URL]) {
    const url = new URL(origin);
    if (url.origin !== origin || url.username || url.password)
      throw new Error('Public URLs must be origins without credentials or paths.');
    if (
      url.protocol !== 'https:' &&
      !(local && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
      throw new Error('Remote origins require HTTPS.');
  }
  if (!origins.length) throw new Error('At least one WEB_ORIGINS entry is required.');
  if (local && !['localhost', '127.0.0.1', '::1'].includes(config.HOST))
    throw new Error('Development and test listeners must bind to loopback.');
  if (!local && db.searchParams.get('sslmode') !== 'verify-full')
    throw new Error('Deployed databases require sslmode=verify-full.');
  if (
    !local &&
    ['sslcert', 'sslkey', 'sslrootcert', 'ssl', 'uselibpqcompat'].some((k) => db.searchParams.has(k))
  )
    throw new Error('Configure deployed database TLS through DATABASE_CA_PATH, without URL TLS overrides.');
  const trustedProxies = config.TRUSTED_PROXY_CIDRS.split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  for (const cidr of trustedProxies) {
    const [address, prefix, extra] = cidr.split('/');
    const version = isIP(address!);
    if (
      !version ||
      extra !== undefined ||
      (prefix !== undefined &&
        (!/^\d+$/.test(prefix) || Number(prefix) < 8 || Number(prefix) > (version === 4 ? 32 : 128)))
    )
      throw new Error('Trusted proxies must be explicit IPs or scoped CIDRs (prefix at least /8).');
  }
  if (local && trustedProxies.length) throw new Error('Local listeners must not trust forwarded addresses.');
  if (config.LIVE_COMMERCE === 'true') {
    if (
      config.APP_ENV !== 'production' ||
      config.STRIPE_MODE !== 'live' ||
      config.EMAIL_MODE !== 'resend' ||
      !config.RESEND_WEBHOOK_SECRETS ||
      config.STORAGE_MODE !== 's3' ||
      !config.APP_ENCRYPTION_KEY ||
      !config.RELEASE_APPROVAL_PATH ||
      !config.RELEASE_REVISION
    )
      throw new Error(
        'Live commerce requires production providers and an artifact-specific release approval.',
      );
    readReleaseManifest(
      config.RELEASE_APPROVAL_PATH,
      config.RELEASE_REVISION,
      config.PUBLIC_API_URL,
      origins,
    );
  }
  const previousKeys = config.APP_ENCRYPTION_PREVIOUS_KEYS.split(',').filter(Boolean);
  if (
    previousKeys.length > 2 ||
    previousKeys.some((value) => !/^[a-f0-9]{64}$/i.test(value)) ||
    (previousKeys.length && !config.APP_ENCRYPTION_KEY)
  )
    throw new Error('Encryption rotation requires an active key and at most two valid previous keys.');
  const encryptionKeys = [
    ...new Set([config.APP_ENCRYPTION_KEY, ...previousKeys].filter((key): key is string => Boolean(key))),
  ];
  return Object.freeze({ ...config, webOrigins: origins, trustedProxies, encryptionKeys });
}
