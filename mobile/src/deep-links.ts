export type DeepLinkTarget = { kind: 'booking' | 'ticket' | 'group' | 'support'; id: string };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function parseDeepLink(value: string, websiteOrigin?: string): DeepLinkTarget | null {
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    const custom = url.protocol === 'clubby:';
    if (!custom && (!websiteOrigin || url.origin !== websiteOrigin)) return null;
    const path = custom ? `/${url.hostname}${url.pathname}` : url.pathname;
    const match = /^\/(bookings|tickets|groups|support)\/([^/]+)\/?$/.exec(path);
    if (match && uuid.test(match[2]!)) {
      const kind = { bookings: 'booking', tickets: 'ticket', groups: 'group', support: 'support' }[
        match[1]!
      ] as DeepLinkTarget['kind'];
      return { kind, id: match[2]! };
    }
    if (path === '/' || (custom && path === '/payment-return')) {
      const booking = url.searchParams.get('booking');
      if (booking && uuid.test(booking)) return { kind: 'booking', id: booking };
    }
    return null;
  } catch {
    return null;
  }
}
