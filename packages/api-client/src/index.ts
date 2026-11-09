import {
  bootstrapSchema,
  venueListSchema,
  venueResponseSchema,
  offerSchema,
  heldOrderSchema,
  orderSummarySchema,
  orderResponseSchema,
  paymentSessionSchema,
  ticketResponseSchema,
  tableAvailabilitySchema,
  groupResponseSchema,
  groupMessagesSchema,
  groupUpdatesSchema,
} from '@clubby/contracts';
import { z } from 'zod';

export class ClubbyApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly requestId: string,
    message: string,
  ) {
    super(message);
  }
}

export class ClubbyClient {
  private readonly origin: string;
  private refreshFlight?: Promise<void>;
  private authenticationEpoch = 0;
  constructor(
    baseUrl: string,
    private readonly options: {
      channel: 'web' | 'ios' | 'staff';
      fetch?: typeof fetch;
      accessToken?: () => Promise<string | undefined>;
      csrfToken?: () => Promise<string | undefined>;
      authentication?: () => Promise<{ token?: string; csrfToken?: string; subject?: string }>;
      refreshAuthentication?: () => Promise<void>;
    },
  ) {
    const url = new URL(baseUrl);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new Error('An API origin is required.');
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw new Error('Remote APIs require HTTPS.');
    this.origin = url.origin;
  }
  invalidateAuthentication() {
    this.authenticationEpoch++;
  }
  async request(path: string, init: RequestInit = {}): Promise<unknown> {
    return this.perform(path, init, true, this.authenticationEpoch);
  }
  async blob(path: string): Promise<Blob> {
    return this.perform(path, {}, true, this.authenticationEpoch, undefined, 'blob') as Promise<Blob>;
  }
  private async perform(
    path: string,
    init: RequestInit,
    recover: boolean,
    epoch: number,
    subject?: string,
    responseType: 'json' | 'blob' = 'json',
  ): Promise<unknown> {
    if (!path.startsWith('/v1/') || path.includes('://') || path.includes('\\'))
      throw new Error('Invalid API path.');
    const target = new URL(path, this.origin);
    if (target.origin !== this.origin || !target.pathname.startsWith('/v1/'))
      throw new Error('Invalid API path.');
    const auth = this.options.authentication
      ? await this.options.authentication()
      : {
          token: await this.options.accessToken?.(),
          csrfToken: await this.options.csrfToken?.(),
          subject: undefined,
        };
    if (epoch !== this.authenticationEpoch || (subject !== undefined && auth.subject !== subject))
      throw new ClubbyApiError(
        409,
        'SESSION_CHANGED',
        '',
        'The signed-in account changed. Start this action again.',
      );
    const token = auth.token;
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    headers.set('x-clubby-channel', this.options.channel);
    headers.set('x-clubby-api-version', 'v1');
    if (token) headers.set('authorization', `Bearer ${token}`);
    const csrf = auth.csrfToken;
    if (csrf && !['GET', 'HEAD'].includes(init.method ?? 'GET')) headers.set('x-csrf-token', csrf);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const abort = () => controller.abort();
    init.signal?.addEventListener('abort', abort, { once: true });
    if (init.signal?.aborted) abort();
    try {
      const response = await (this.options.fetch ?? fetch)(target.href, {
        ...init,
        headers,
        credentials: this.options.channel === 'web' ? 'include' : 'omit',
        redirect: 'error',
        signal: controller.signal,
      });
      const result = response.ok && responseType === 'blob' ? await response.blob() : await response.json();
      if (!response.ok) {
        const error = result?.error;
        // Only a guard rejection proves that a mutation never ran. Never replay network errors or
        // a business-level authorization failure; JSON bodies and idempotency keys are preserved.
        if (
          recover &&
          response.status === 401 &&
          error?.code === 'UNAUTHENTICATED' &&
          auth.subject &&
          this.options.refreshAuthentication &&
          (!init.body || typeof init.body === 'string') &&
          !controller.signal.aborted
        ) {
          if (epoch !== this.authenticationEpoch)
            throw new ClubbyApiError(
              409,
              'SESSION_CHANGED',
              '',
              'The signed-in account changed. Start this action again.',
            );
          const current = await this.options.authentication!();
          if (current.subject !== auth.subject)
            throw new ClubbyApiError(
              409,
              'SESSION_CHANGED',
              '',
              'The signed-in account changed. Start this action again.',
            );
          if (current.token === token) {
            if (!this.refreshFlight)
              this.refreshFlight = (async () => {
                const latest = await this.options.authentication!();
                if (epoch !== this.authenticationEpoch || latest.subject !== auth.subject)
                  throw new ClubbyApiError(
                    409,
                    'SESSION_CHANGED',
                    '',
                    'The signed-in account changed. Start this action again.',
                  );
                if (latest.token === token) await this.options.refreshAuthentication!();
              })().finally(() => {
                this.refreshFlight = undefined;
              });
            await this.refreshFlight;
          }
          if (controller.signal.aborted) throw controller.signal.reason;
          return this.perform(path, init, false, epoch, auth.subject, responseType);
        }
        throw new ClubbyApiError(
          response.status,
          error?.code ?? 'REQUEST_FAILED',
          error?.requestId ?? '',
          error?.message ?? 'Request failed.',
        );
      }
      if (
        epoch !== this.authenticationEpoch ||
        (auth.subject && (await this.options.authentication?.())?.subject !== auth.subject)
      )
        throw new ClubbyApiError(
          409,
          'SESSION_CHANGED',
          '',
          'The signed-in account changed. Start this action again.',
        );
      return result;
    } finally {
      clearTimeout(timeout);
      init.signal?.removeEventListener('abort', abort);
    }
  }
  async bootstrap() {
    return bootstrapSchema.parse(await this.request('/v1/bootstrap'));
  }
  async group(id: string) {
    return groupResponseSchema.parse(await this.request(`/v1/groups/${encodeURIComponent(id)}`));
  }
  async groupMessages(id: string, after = '0') {
    return groupMessagesSchema.parse(
      await this.request(`/v1/groups/${encodeURIComponent(id)}/messages?after=${encodeURIComponent(after)}`),
    );
  }
  async groupUpdates(id: string, after = '0') {
    return groupUpdatesSchema.parse(
      await this.request(`/v1/groups/${encodeURIComponent(id)}/updates?after=${encodeURIComponent(after)}`),
    );
  }
  async venues(city = 'milan') {
    return venueListSchema.parse(await this.request(`/v1/venues?city=${encodeURIComponent(city)}`));
  }
  async venue(id: string) {
    return venueResponseSchema.parse(await this.request(`/v1/venues/${encodeURIComponent(id)}`));
  }
  post(path: string, body: unknown, idempotencyKey?: string) {
    return this.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    });
  }
  async offers(occurrenceId: string) {
    return z
      .object({ data: z.array(offerSchema) })
      .parse(await this.request(`/v1/occurrences/${encodeURIComponent(occurrenceId)}/offers`));
  }
  async tables(occurrenceId: string) {
    return tableAvailabilitySchema.parse(
      await this.request(`/v1/occurrences/${encodeURIComponent(occurrenceId)}/tables`),
    );
  }
  async reserveTable(
    input: {
      offerId: string;
      expectedVersion: number;
      guests: number;
      paymentMode: 'full' | 'deposit';
      email: string;
    },
    key: string,
  ) {
    return z
      .object({
        data: z.object({
          reservationId: z.string().uuid(),
          order: heldOrderSchema.shape.data,
          balanceDueMinor: z.number().int(),
        }),
      })
      .parse(await this.post('/v1/table-reservations', input, key));
  }
  async createOrder(
    input: {
      occurrenceId: string;
      items: { productId: string; quantity: number; extraDrinks?: number }[];
      email: string;
      promotionCode?: string;
    },
    key: string,
  ) {
    return heldOrderSchema.parse(await this.post('/v1/orders', input, key));
  }
  async orders() {
    return z.object({ data: z.array(orderSummarySchema) }).parse(await this.request('/v1/orders'));
  }
  async order(id: string) {
    return orderResponseSchema.parse(await this.request(`/v1/orders/${encodeURIComponent(id)}`));
  }
  async payment(id: string, options?: { useSavedMethods: boolean; saveCard: boolean }) {
    return paymentSessionSchema.parse(
      await this.post(`/v1/orders/${encodeURIComponent(id)}/payment`, { acceptTerms: true, ...options }),
    );
  }
  async ticket(id: string) {
    return ticketResponseSchema.parse(await this.request(`/v1/tickets/${encodeURIComponent(id)}`));
  }
}
