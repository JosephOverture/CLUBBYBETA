import { readFile } from 'node:fs/promises';
import { connect } from 'node:http2';
import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';
import type { Config } from '../platform/config';
export interface PushProvider {
  send(token: string, notificationId: string, deliveryId: string): Promise<'sent' | 'unregistered'>;
}
export class ApnsProvider implements PushProvider {
  private authorization?: { token: string; expires: number };
  constructor(
    readonly config: Config,
    private readonly connector: typeof connect = connect,
  ) {}
  async auth() {
    if (this.authorization && this.authorization.expires > Date.now()) return this.authorization.token;
    const key = await importPKCS8(await readFile(this.config.APPLE_PUSH_KEY_PATH!, 'utf8'), 'ES256');
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: this.config.APPLE_PUSH_KEY_ID! })
      .setIssuer(this.config.APPLE_TEAM_ID!)
      .setIssuedAt()
      .sign(key);
    this.authorization = { token, expires: Date.now() + 50 * 60_000 };
    return token;
  }
  async send(token: string, notificationId: string, deliveryId: string): Promise<'sent' | 'unregistered'> {
    if (this.config.APPLE_PUSH_ENABLED !== 'true') throw new Error('iOS push is not configured.');
    z.string()
      .regex(/^[a-f0-9]{32,256}$/i)
      .parse(token);
    z.string().uuid().parse(notificationId);
    z.string().uuid().parse(deliveryId);
    const authorization = await this.auth();
    return new Promise((resolve, reject) => {
      const client = this.connector(
        this.config.APPLE_PUSH_ENVIRONMENT === 'production'
          ? 'https://api.push.apple.com'
          : 'https://api.sandbox.push.apple.com',
      );
      let done = false;
      const finish = (error?: Error, result?: 'sent' | 'unregistered') => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        client.close();
        if (error) reject(error);
        else resolve(result!);
      };
      const timer = setTimeout(() => {
        client.destroy();
        finish(new Error('APNs request timed out.'));
      }, 10_000);
      client.on('error', () => finish(new Error('APNs connection failed.')));
      const request = client.request({
        ':method': 'POST',
        ':path': `/3/device/${token}`,
        authorization: `bearer ${authorization}`,
        'apns-topic': this.config.APPLE_PUSH_BUNDLE_ID!,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-id': deliveryId,
        'apns-collapse-id': notificationId,
        'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600),
        'content-type': 'application/json',
      });
      let status = 0,
        body = '';
      request.on('response', (headers) => {
        status = Number(headers[':status']);
      });
      request.on('data', (value) => {
        if (body.length < 4096) body += value.toString();
      });
      request.on('error', () => finish(new Error('APNs request failed.')));
      request.on('end', () => {
        if (status === 200) finish(undefined, 'sent');
        else if (status === 410 || (status === 400 && body.includes('BadDeviceToken')))
          finish(undefined, 'unregistered');
        else finish(new Error(`APNs rejected notification (${status}).`));
      });
      // No booking, message, name, email or credential appears on a lock screen or in the push payload.
      request.end(
        JSON.stringify({
          aps: { alert: { title: 'Clubby', body: 'You have a new update in Clubby.' }, sound: 'default' },
          notificationId,
        }),
      );
    });
  }
}
