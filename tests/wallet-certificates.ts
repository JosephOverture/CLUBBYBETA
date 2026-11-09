import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import forge from 'node-forge';
export async function walletCertificates() {
  const directory = await mkdtemp(join(tmpdir(), 'clubby-wallet-test-'));
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const key = forge.pki.privateKeyFromPem(pair.privateKey),
    cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(pair.publicKey);
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86400_000);
  cert.validity.notAfter = new Date(Date.now() + 86400_000);
  cert.setSubject([{ name: 'commonName', value: 'Clubby offline test certificate - not trusted by Apple' }]);
  cert.setIssuer(cert.subject.attributes);
  cert.sign(key, forge.md.sha256.create());
  const certificate = forge.pki.certificateToPem(cert),
    certPath = join(directory, 'cert.pem'),
    keyPath = join(directory, 'key.pem'),
    googlePath = join(directory, 'google.pem');
  await Promise.all([
    writeFile(certPath, certificate),
    writeFile(keyPath, pair.privateKey, { mode: 0o600 }),
    writeFile(
      googlePath,
      forge.pki.privateKeyInfoToPem(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(key))),
      { mode: 0o600 },
    ),
  ]);
  return {
    certificate,
    publicKey: pair.publicKey,
    env: {
      PUBLIC_API_URL: 'https://api.clubby.test',
      APPLE_WALLET_ENABLED: 'true',
      APPLE_PASS_TYPE_ID: 'pass.test.clubby',
      APPLE_TEAM_ID: 'TESTTEAM01',
      APPLE_PASS_CERT_PATH: certPath,
      APPLE_PASS_KEY_PATH: keyPath,
      APPLE_WWDR_CERT_PATH: certPath,
      GOOGLE_WALLET_ENABLED: 'true',
      GOOGLE_WALLET_ISSUER_ID: '123456',
      GOOGLE_WALLET_CLIENT_EMAIL: 'test@clubby-test.iam.gserviceaccount.com',
      GOOGLE_WALLET_KEY_PATH: googlePath,
    },
    async dispose() {
      const rel = relative(resolve(tmpdir()), resolve(directory));
      if (!rel.startsWith('clubby-wallet-test-') || rel.includes('..') || isAbsolute(rel))
        throw new Error('Unsafe wallet test cleanup path.');
      await rm(directory, { recursive: true, force: true });
    },
  };
}
export function passFiles(buffer: Buffer) {
  const result: Record<string, Buffer> = {};
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    if (buffer.readUInt16LE(offset + 8) !== 0) throw new Error('Expected uncompressed pass fixture ZIP.');
    const size = buffer.readUInt32LE(offset + 18),
      nameSize = buffer.readUInt16LE(offset + 26),
      extraSize = buffer.readUInt16LE(offset + 28),
      start = offset + 30 + nameSize + extraSize;
    result[buffer.subarray(offset + 30, offset + 30 + nameSize).toString()] = buffer.subarray(
      start,
      start + size,
    );
    offset = start + size;
  }
  return result;
}
