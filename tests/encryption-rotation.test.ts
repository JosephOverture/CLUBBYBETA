import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from '../apps/api/src/platform/crypto';
import { readConfig } from '../apps/api/src/platform/config';
describe('bounded encryption key overlap', () => {
  it('reads old records with overlap, writes with only the current key and rejects tampering', () => {
    const old = 'a1'.repeat(32),
      next = 'b2'.repeat(32),
      value = { token: 'private-value' };
    const legacy = encrypt(value, old);
    expect(decrypt(legacy, [next, old])).toEqual(value);
    const current = encrypt(value, [next, old]);
    expect(decrypt(current, next)).toEqual(value);
    expect(() => decrypt(current, old)).toThrow('authenticated');
    expect(() => decrypt(current + '.extra', [next, old])).toThrow('Invalid encrypted');
    expect(() => decrypt(current.slice(0, -8) + 'XXXXXXXX', [next, old])).toThrow();
    expect(() =>
      readConfig({ DATABASE_URL: 'postgres://localhost/test', APP_ENCRYPTION_PREVIOUS_KEYS: old }),
    ).toThrow('active key');
  });
});
