import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const releaseChecks = [
  'provider-payments-refunds-disputes',
  'seller-commercial-policies',
  'security-privacy-review',
  'backup-restore-and-alert-delivery',
  'capacity-and-outage-rehearsal',
  'web-customer-seller-door-journeys',
  'signed-ios-device-journeys',
  'apple-entitlements-and-store-metadata',
] as const;
const evidence = z
  .object({
    result: z.literal('passed'),
    reviewer: z.string().min(3).max(200),
    evidence: z
      .string()
      .url()
      .refine((v) => new URL(v).protocol === 'https:'),
  })
  .strict();
const manifestSchema = z
  .object({
    environment: z.literal('production'),
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    apiOrigin: z.string().url(),
    webOrigins: z.array(z.string().url()).min(1),
    approvedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    checks: z.record(z.enum(releaseChecks), evidence),
  })
  .strict();

/** Deployment-owner attestation, tied to the exact artifact. Never treats a template as evidence. */
export function verifyReleaseManifest(
  value: unknown,
  revision: string,
  apiOrigin: string,
  webOrigins: string[],
  now = Date.now(),
) {
  const result = manifestSchema.safeParse(value);
  if (!result.success) throw new Error('Release approval is incomplete or invalid.');
  const manifest = result.data;
  const approved = Date.parse(manifest.approvedAt);
  const expires = Date.parse(manifest.expiresAt);
  if (
    manifest.revision !== revision ||
    manifest.apiOrigin !== apiOrigin ||
    [...manifest.webOrigins].sort().join(',') !== [...webOrigins].sort().join(',') ||
    approved > now ||
    expires <= now ||
    expires <= approved ||
    expires - approved > 30 * 86400_000
  )
    throw new Error('Release approval does not match this artifact/origins or has expired.');
  return manifest;
}
export function readReleaseManifest(path: string, revision: string, apiOrigin: string, webOrigins: string[]) {
  let value: unknown;
  try {
    const bytes = readFileSync(path);
    if (bytes.length > 64 * 1024) throw new Error();
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Release approval file cannot be read.');
  }
  return verifyReleaseManifest(value, revision, apiOrigin, webOrigins);
}
