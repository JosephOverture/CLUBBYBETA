import { readFile } from 'node:fs/promises';
import { connect } from 'node:http2';
import { SignJWT, importPKCS8 } from 'jose';
import { PKPass, PassType } from 'passkit-generator';
import sharp from 'sharp';
import { z } from 'zod';
import type { Config } from '../platform/config';

export type WalletTicket = {
  id: string;
  ticketId: string;
  occurrenceId: string;
  revision: string;
  authToken: string;
  credential: string | null;
  title: string;
  venueName: string;
  venueAddress: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  terms: string;
  active: boolean;
  status: string;
  drinksRemaining: number;
  tableLabel: string | null;
  balanceDueMinor: number;
  currency: string;
};
export interface WalletProvider {
  capabilities(): { apple: boolean; google: boolean };
  applePass(ticket: WalletTicket): Promise<Buffer>;
  applePush(token: string): Promise<'sent' | 'unregistered'>;
  googleUpdate(ticket: WalletTicket): Promise<void>;
  googleSave(id: string): Promise<string>;
}
export class SignedWalletProvider implements WalletProvider {
  private googleToken?: { value: string; expires: number };
  constructor(
    readonly config: Config,
    readonly transport: typeof fetch = fetch,
  ) {}
  capabilities() {
    return {
      apple: this.config.APPLE_WALLET_ENABLED === 'true',
      google: this.config.GOOGLE_WALLET_ENABLED === 'true',
    };
  }
  async applePass(ticket: WalletTicket) {
    if (!this.capabilities().apple) throw new Error('Apple Wallet is not configured.');
    const [signerCert, signerKey, wwdr] = await Promise.all([
      readFile(this.config.APPLE_PASS_CERT_PATH!),
      readFile(this.config.APPLE_PASS_KEY_PATH!),
      readFile(this.config.APPLE_WWDR_CERT_PATH!),
    ]);
    // Code-generated monochrome brand mark; the signed payload never includes personal payment data.
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="87" height="87"><rect width="87" height="87" rx="18" fill="#171d14"/><path d="M62 24A27 27 0 1 0 62 63" fill="none" stroke="#cdff80" stroke-width="10"/></svg>',
    );
    const buffers: Record<string, Buffer> = {};
    for (const [name, size] of [
      ['icon.png', 29],
      ['icon@2x.png', 58],
      ['icon@3x.png', 87],
    ] as const)
      buffers[name] = await sharp(svg).resize(size, size).png().toBuffer();
    const pass = new PKPass(
      buffers,
      { signerCert, signerKey, wwdr, signerKeyPassphrase: this.config.APPLE_PASS_KEY_PASSPHRASE },
      {
        formatVersion: 1,
        passTypeIdentifier: this.config.APPLE_PASS_TYPE_ID!,
        teamIdentifier: this.config.APPLE_TEAM_ID!,
        serialNumber: ticket.id,
        organizationName: 'Clubby',
        description: 'Clubby event admission',
        logoText: 'Clubby',
        backgroundColor: 'rgb(23, 29, 20)',
        foregroundColor: 'rgb(247, 246, 239)',
        labelColor: 'rgb(205, 255, 128)',
        webServiceURL: `${this.config.PUBLIC_API_URL}/v1/wallet/apple`,
        authenticationToken: ticket.authToken,
        sharingProhibited: true,
        voided: !ticket.active,
      },
    );
    const event = new PassType('eventTicket');
    event.primaryFields.push({ key: 'event', label: 'EVENT', value: ticket.title });
    event.secondaryFields.push({ key: 'venue', label: 'VENUE', value: ticket.venueName });
    event.auxiliaryFields.push(
      {
        key: 'date',
        label: 'START',
        value: new Intl.DateTimeFormat('en-GB', {
          timeZone: ticket.timezone,
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(ticket.startsAt)),
        changeMessage: 'Event time updated: %@',
      },
      { key: 'state', label: 'STATUS', value: ticket.status, changeMessage: 'Ticket status: %@' },
    );
    event.backFields.push(
      { key: 'terms', label: 'BOOKING TERMS', value: ticket.terms },
      { key: 'ticket', label: 'TICKET', value: ticket.ticketId },
      {
        key: 'drinks',
        label: 'DRINKS REMAINING',
        value: ticket.drinksRemaining,
        changeMessage: 'Drinks remaining: %@',
      },
    );
    if (ticket.tableLabel)
      event.backFields.push(
        { key: 'table', label: 'TABLE', value: ticket.tableLabel },
        {
          key: 'balance',
          label: 'TABLE BALANCE BEFORE ENTRY',
          value: new Intl.NumberFormat('en-GB', { style: 'currency', currency: ticket.currency }).format(
            ticket.balanceDueMinor / 100,
          ),
          changeMessage: 'Table balance: %@',
        },
      );
    pass.types.push(event);
    pass.setRelevantDate(new Date(ticket.startsAt));
    pass.setRelevantDates([{ startDate: ticket.startsAt, endDate: ticket.endsAt }]);
    pass.setExpirationDate(new Date(Date.parse(ticket.endsAt) + 6 * 3600_000));
    if (ticket.active && ticket.credential)
      pass.setBarcodes({
        format: 'PKBarcodeFormatQR',
        message: ticket.credential,
        messageEncoding: 'iso-8859-1',
        altText: 'Present at the venue',
      });
    return pass.getAsBuffer();
  }
  async applePush(token: string): Promise<'sent' | 'unregistered'> {
    const [cert, key] = await Promise.all([
      readFile(this.config.APPLE_PASS_CERT_PATH!),
      readFile(this.config.APPLE_PASS_KEY_PATH!),
    ]);
    // Wallet uses the pass certificate and the production APNs endpoint, including development passes.
    return new Promise((resolve, reject) => {
      const client = connect('https://api.push.apple.com', {
        cert,
        key,
        passphrase: this.config.APPLE_PASS_KEY_PASSPHRASE,
      });
      const timer = setTimeout(() => {
        client.destroy();
        reject(new Error('Wallet push timed out.'));
      }, 10_000);
      client.on('error', fail);
      function fail() {
        clearTimeout(timer);
        client.destroy();
        reject(new Error('Wallet push failed.'));
      }
      const request = client.request({
        ':method': 'POST',
        ':path': `/3/device/${z
          .string()
          .regex(/^[a-f0-9]{32,256}$/i)
          .parse(token)}`,
        'apns-topic': this.config.APPLE_PASS_TYPE_ID!,
        'apns-push-type': 'background',
        'apns-priority': '5',
        'content-type': 'application/json',
      });
      let status = 0,
        body = '';
      request.on('response', (h) => {
        status = Number(h[':status']);
      });
      request.on('data', (b) => {
        if (body.length < 4096) body += b.toString();
      });
      request.on('error', fail);
      request.on('end', () => {
        clearTimeout(timer);
        client.close();
        if (status === 200) resolve('sent');
        else if (status === 410 || (status === 400 && body.includes('BadDeviceToken')))
          resolve('unregistered');
        else reject(new Error(`Wallet push status ${status}.`));
      });
      request.end('{}');
    });
  }
  private async key() {
    return importPKCS8(await readFile(this.config.GOOGLE_WALLET_KEY_PATH!, 'utf8'), 'RS256');
  }
  private async token() {
    if (this.googleToken && this.googleToken.expires > Date.now() + 60_000) return this.googleToken.value;
    const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/wallet_object.issuer' })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.config.GOOGLE_WALLET_CLIENT_EMAIL!)
      .setAudience('https://oauth2.googleapis.com/token')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(await this.key());
    const response = await this.transport('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Google Wallet token status ${response.status}.`);
    const value = z.object({ access_token: z.string(), expires_in: z.number() }).parse(await response.json());
    this.googleToken = {
      value: value.access_token,
      expires: Date.now() + Math.min(value.expires_in, 3600) * 1000,
    };
    return value.access_token;
  }
  private async put(
    kind: 'eventTicketClass' | 'eventTicketObject',
    id: string,
    value: Record<string, unknown>,
    token: string,
  ) {
    const base = `https://walletobjects.googleapis.com/walletobjects/v1/${kind}`;
    const request = (url: string, method: string) =>
      this.transport(url, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(
          method === 'PATCH' && kind === 'eventTicketClass'
            ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'reviewStatus'))
            : value,
        ),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    let result = await request(`${base}/${encodeURIComponent(id)}`, 'PATCH');
    if (result.status === 404) {
      result = await request(base, 'POST');
      if (result.status === 409) result = await request(`${base}/${encodeURIComponent(id)}`, 'PATCH');
    }
    if (!result.ok) throw new Error(`Google Wallet ${kind} status ${result.status}.`);
  }
  async googleUpdate(ticket: WalletTicket) {
    if (!this.capabilities().google) throw new Error('Google Wallet is not configured.');
    const prefix = this.config.GOOGLE_WALLET_ISSUER_ID!,
      token = await this.token();
    const localized = (value: string) => ({ defaultValue: { language: 'en', value } });
    // Each ownership version has an independent class/object: updates can never expose a new owner's QR to an old holder.
    const id = `${prefix}.${ticket.id}`,
      classId = `${prefix}.event_${ticket.id}`;
    await this.put(
      'eventTicketClass',
      classId,
      {
        id: classId,
        issuerName: 'Clubby',
        eventName: localized(ticket.title),
        venue: { name: localized(ticket.venueName), address: localized(ticket.venueAddress) },
        dateTime: {
          start: this.zoned(ticket.startsAt, ticket.timezone),
          end: this.zoned(ticket.endsAt, ticket.timezone),
        },
        reviewStatus: 'UNDER_REVIEW',
      },
      token,
    );
    await this.put(
      'eventTicketObject',
      id,
      {
        id,
        classId,
        state: ticket.active ? 'ACTIVE' : 'INACTIVE',
        hexBackgroundColor: '#171d14',
        ticketNumber: ticket.ticketId,
        barcode: {
          type: 'QR_CODE',
          value: ticket.active && ticket.credential ? ticket.credential : `inactive:${ticket.id}`,
        },
        validTimeInterval: {
          start: { date: new Date(Date.parse(ticket.startsAt) - 6 * 3600_000).toISOString() },
          end: { date: new Date(Date.parse(ticket.endsAt) + 6 * 3600_000).toISOString() },
        },
        textModulesData: [
          { id: 'status', header: 'Status', body: ticket.status },
          { id: 'terms', header: 'Booking terms', body: ticket.terms },
          { id: 'drinks', header: 'Drinks remaining', body: String(ticket.drinksRemaining) },
          ...(ticket.tableLabel
            ? [
                {
                  id: 'table',
                  header: 'Table',
                  body: `${ticket.tableLabel} · Balance before entry ${new Intl.NumberFormat('en-GB', { style: 'currency', currency: ticket.currency }).format(ticket.balanceDueMinor / 100)}`,
                },
              ]
            : []),
        ],
      },
      token,
    );
  }
  async googleSave(id: string) {
    const jwt = await new SignJWT({
      typ: 'savetowallet',
      origins: this.config.webOrigins,
      payload: { eventTicketObjects: [{ id: `${this.config.GOOGLE_WALLET_ISSUER_ID}.${id}` }] },
    })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.config.GOOGLE_WALLET_CLIENT_EMAIL!)
      .setAudience('google')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(await this.key());
    return `https://pay.google.com/gp/v/save/${jwt}`;
  }
  private zoned(value: string, timezone: string) {
    const values = Object.fromEntries(
      new Intl.DateTimeFormat('sv-SE', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
        timeZoneName: 'longOffset',
      })
        .formatToParts(new Date(value))
        .map((p) => [p.type, p.value]),
    );
    return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}${values.timeZoneName!.replace('GMT', '') || '+00:00'}`;
  }
}
