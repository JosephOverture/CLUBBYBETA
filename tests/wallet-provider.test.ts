import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { createHash, createPublicKey, verify } from 'node:crypto';
import forge from 'node-forge';
import { jwtVerify } from 'jose';
import { walletCertificates, passFiles } from './wallet-certificates';
import { SignedWalletProvider, type WalletTicket } from '../apps/api/src/tickets/wallet-provider';
import { readConfig } from '../apps/api/src/platform/config';
describe('signed wallet provider contracts', () => {
  let cert: Awaited<ReturnType<typeof walletCertificates>>, provider: SignedWalletProvider;
  const calls: { url: string; method: string; body: any }[] = [];
  const ticket: WalletTicket = {
    id: 'e35e2b4e-06b7-42ef-99cb-0d8f5e6c7120',
    ticketId: 'ff46818c-465a-49e8-aa2a-c626350fc9e8',
    occurrenceId: 'f0199b57-11fd-44d8-9d89-83b0b9c2b4a5',
    revision: '1',
    authToken: 'a'.repeat(43),
    credential: 'b'.repeat(43),
    title: 'Clubby live',
    venueName: 'Example venue',
    venueAddress: '10 Example Street, Milan',
    startsAt: '2026-10-25T01:30:00.000Z',
    endsAt: '2026-10-25T03:30:00.000Z',
    timezone: 'Europe/Rome',
    terms: 'Fixture terms',
    active: true,
    status: 'Valid admission',
    drinksRemaining: 2,
    tableLabel: null,
    balanceDueMinor: 0,
    currency: 'EUR',
  };
  beforeAll(async () => {
    cert = await walletCertificates();
    provider = new SignedWalletProvider(
      readConfig({
        DATABASE_URL: 'postgresql://local:local@127.0.0.1/test',
        APP_ENV: 'test',
        APP_ENCRYPTION_KEY: 'a1'.repeat(32),
        ...cert.env,
      }),
      async (url, options) => {
        const target = String(url);
        calls.push({
          url: target,
          method: options?.method ?? 'GET',
          body: target.includes('oauth2')
            ? Object.fromEntries(new URLSearchParams(options?.body as string))
            : JSON.parse(options?.body as string),
        });
        return new Response(
          JSON.stringify(
            target.includes('oauth2') ? { access_token: 'fixture-access-token', expires_in: 3600 } : {},
          ),
          {
            status:
              target.endsWith(ticket.id) &&
              options?.method === 'PATCH' &&
              calls.filter((c) => c.url === target).length === 1
                ? 404
                : 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      },
    );
  });
  afterAll(async () => {
    if (cert) await cert.dispose();
  });
  it('signs a complete Apple pass with verifiable manifest and detached CMS signature', async () => {
    const files = passFiles(await provider.applePass(ticket)),
      pass = JSON.parse(files['pass.json']!.toString()),
      manifest = JSON.parse(files['manifest.json']!.toString());
    expect(pass).toMatchObject({
      serialNumber: ticket.id,
      passTypeIdentifier: 'pass.test.clubby',
      authenticationToken: ticket.authToken,
      voided: false,
      sharingProhibited: true,
    });
    expect(pass.barcodes[0].message).toBe(ticket.credential);
    for (const [name, digest] of Object.entries(manifest))
      expect(createHash('sha1').update(files[name]!).digest('hex')).toBe(digest);
    const cms = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(files.signature!.toString('binary'))) as any;
    const raw = cms.rawCapture,
      attributes = forge.asn1.create(
        forge.asn1.Class.UNIVERSAL,
        forge.asn1.Type.SET,
        true,
        raw.authenticatedAttributes,
      );
    expect(
      verify(
        'RSA-SHA1',
        Buffer.from(forge.asn1.toDer(attributes).getBytes(), 'binary'),
        cert.publicKey,
        Buffer.from(raw.signature, 'binary'),
      ),
    ).toBe(true);
    const digestAttribute = raw.authenticatedAttributes.find(
      (a: any) => forge.asn1.derToOid(a.value[0].value) === forge.pki.oids.messageDigest,
    );
    expect(Buffer.from(digestAttribute.value[1].value[0].value, 'binary').toString('hex')).toBe(
      createHash('sha1').update(files['manifest.json']!).digest('hex'),
    );
  });
  it('removes all admission barcodes from a voided ownership version', async () => {
    const pass = JSON.parse(
      passFiles(await provider.applePass({ ...ticket, active: false, credential: null, status: 'Inactive' }))[
        'pass.json'
      ]!.toString(),
    );
    expect(pass.voided).toBe(true);
    expect(pass.barcodes ?? []).toHaveLength(0);
  });
  it('uses signed OAuth and creates/updates Google resources with local DST dates and no payment credentials', async () => {
    await provider.googleUpdate(ticket);
    const oauth = calls.find((c) => c.url.includes('oauth2'))!,
      assertion = await jwtVerify(oauth.body.assertion, createPublicKey(cert.publicKey), {
        audience: 'https://oauth2.googleapis.com/token',
        issuer: cert.env.GOOGLE_WALLET_CLIENT_EMAIL,
      });
    expect(assertion.payload.scope).toBe('https://www.googleapis.com/auth/wallet_object.issuer');
    const event = calls.find((c) => c.url.includes('/eventTicketClass/'))!;
    expect(event.body.dateTime.start).toBe('2026-10-25T02:30:00+01:00');
    expect(event.body.venue.address.defaultValue.value).toBe(ticket.venueAddress);
    expect(event.body.reviewStatus).toBeUndefined();
    const object = calls.find((c) => c.url.endsWith('/eventTicketObject') && c.method === 'POST')!;
    expect(object.body.barcode.value).toBe(ticket.credential);
    expect(JSON.stringify(object.body)).not.toContain(ticket.authToken);
    const link = await provider.googleSave(ticket.id),
      jwt = link.split('/').at(-1)!;
    const verified = await jwtVerify(jwt, createPublicKey(cert.publicKey), {
      audience: 'google',
      issuer: cert.env.GOOGLE_WALLET_CLIENT_EMAIL,
    });
    expect(verified.payload.typ).toBe('savetowallet');
    expect(JSON.stringify(verified.payload)).not.toContain(ticket.credential!);
    await provider.googleUpdate({ ...ticket, active: false, credential: null });
    expect(calls.at(-1)!.body.state).toBe('INACTIVE');
    expect(calls.at(-1)!.body.barcode.value).toBe(`inactive:${ticket.id}`);
    expect(calls.filter((c) => c.url.includes('oauth2'))).toHaveLength(1);
  });
});
