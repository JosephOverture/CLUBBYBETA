import type { PoolClient } from 'pg';
import { ApiError } from '../platform/http';
export type Feature = 'groupCreation' | 'ticketTransfers' | 'walletCreation' | 'chatMessages';
export async function requireFeature(tx: PoolClient, feature: Feature) {
  const row = (await tx.query('SELECT features FROM public_settings WHERE singleton=true')).rows[0];
  if (row?.features?.[feature] !== true)
    throw new ApiError(
      'FEATURE_PAUSED',
      'This action is temporarily unavailable. Existing bookings remain accessible.',
      409,
    );
}
