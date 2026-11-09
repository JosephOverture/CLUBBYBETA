import { randomBytes, createHash, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { ApiError } from './http';

export const secret = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const challengeHash = (value: string) => createHash('sha256').update(value).digest('base64url');
export function equalHash(plaintext: string, expected: string) {
  const actual = Buffer.from(hash(plaintext), 'hex');
  const stored = Buffer.from(expected, 'hex');
  return actual.length === stored.length && timingSafeEqual(actual, stored);
}
function key(value?: string) {
  if (!value || !/^[a-f0-9]{64}$/i.test(value))
    throw new ApiError('NOT_CONFIGURED', 'Identity delivery is not configured.', 503);
  return Buffer.from(value, 'hex');
}
type KeyRing = string | readonly string[] | undefined;
const keys = (value: KeyRing) => (typeof value === 'string' ? [value] : (value ?? []));
export function encrypt(value: unknown, encryptionKey?: KeyRing) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(keys(encryptionKey)[0]), nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [
    nonce.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}
export function decrypt(value: string, encryptionKey?: KeyRing): unknown {
  const [iv, tag, data] = value.split('.');
  if (
    !iv ||
    !tag ||
    !data ||
    value.split('.').length !== 3 ||
    Buffer.from(iv, 'base64url').length !== 12 ||
    Buffer.from(tag, 'base64url').length !== 16
  )
    throw new Error('Invalid encrypted record.');
  for (const candidate of keys(encryptionKey).slice(0, 3)) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key(candidate), Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return JSON.parse(
        Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8'),
      );
    } catch {
      /* Try the bounded overlap keys; never disclose which key failed. */
    }
  }
  throw new Error('Encrypted record could not be authenticated.');
}
