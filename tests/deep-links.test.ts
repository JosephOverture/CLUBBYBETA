import { describe, it, expect } from 'vitest';
import { parseDeepLink } from '../apps/mobile/src/deep-links';
describe('universal and payment link routing', () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    web = 'https://clubby.example';
  it('routes only recognized resources from the associated site or app scheme', () => {
    expect(parseDeepLink(`${web}/bookings/${id}`, web)).toEqual({ kind: 'booking', id });
    expect(parseDeepLink(`clubby://groups/${id}`)).toEqual({ kind: 'group', id });
    expect(parseDeepLink(`clubby://payment-return?booking=${id}`)).toEqual({ kind: 'booking', id });
    expect(parseDeepLink(`${web}/?booking=${id}`, web)).toEqual({ kind: 'booking', id });
    for (const value of [
      `https://evil.example/bookings/${id}`,
      `https://evil@clubby.example/groups/${id}`,
      `javascript:alert(1)`,
      `${web}/groups/nope`,
      `${web}/admin/${id}`,
    ])
      expect(parseDeepLink(value, web)).toBeNull();
  });
});
