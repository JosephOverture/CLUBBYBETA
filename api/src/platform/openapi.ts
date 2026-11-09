import { z } from 'zod';
import {
  bootstrapSchema,
  venueListSchema,
  venueResponseSchema,
  apiErrorSchema,
  heldOrderSchema,
  orderResponseSchema,
  ticketResponseSchema,
  tableAvailabilitySchema,
} from '@clubby/contracts';
import { RequestMethod, type Type } from '@nestjs/common';
import {
  METHOD_METADATA,
  PATH_METADATA,
  HTTP_CODE_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { PUBLIC } from '../identity/session.guard';
import { orderInput } from '../commerce/orders.service';
import { productInput } from '../commerce/inventory.service';
import { layoutInput, tableOfferInput } from '../tables/tables.service';
import { createVenueInput, venueInput } from '../catalogue/catalogue.schemas';
import { loginStartSchema } from '../identity/identity.service';

const json = (schema: z.ZodType) => ({ 'application/json': { schema: z.toJSONSchema(schema) } });
const response = (schema: z.ZodType) => ({ description: 'Success', content: json(schema) });
const requestSchemas: Record<string, z.ZodType> = {
  CommerceController_hold: orderInput,
  CommerceController_quote: orderInput,
  CommerceController_product: productInput,
  CommerceController_editProduct: productInput.extend({
    expectedVersion: z.number().int().positive().optional(),
  }),
  TablesController_layout: layoutInput,
  TablesController_offer: tableOfferInput,
  ManagementController_create: createVenueInput,
  ManagementController_edit: venueInput.extend({ expectedVersion: z.number().int().positive() }),
  IdentityController_start: loginStartSchema,
};
const responseSchemas: Record<string, z.ZodType> = {
  CommerceController_hold: heldOrderSchema,
  CommerceController_ticket: ticketResponseSchema,
  CommerceController_view: orderResponseSchema,
  TablesController_availability: tableAvailabilitySchema,
};
export const openapi = {
  openapi: '3.1.0',
  info: { title: 'Clubby shared API', version: '1.0.0' },
  paths: {
    '/v1/bootstrap': { get: { operationId: 'bootstrap', responses: { '200': response(bootstrapSchema) } } },
    '/v1/venues': {
      get: {
        operationId: 'listVenues',
        parameters: [{ in: 'query', name: 'city', schema: { type: 'string' } }],
        responses: { '200': response(venueListSchema) },
      },
    },
    '/v1/venues/{id}': {
      get: {
        operationId: 'getVenue',
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
        responses: {
          '200': response(venueResponseSchema),
          '404': { description: 'Not found', content: json(apiErrorSchema) },
        },
      },
    },
  },
};

export function documentControllers(controllers: Type<unknown>[]) {
  const paths: Record<string, Record<string, unknown>> = { ...openapi.paths };
  for (const controller of controllers) {
    const prefix = Reflect.getMetadata(PATH_METADATA, controller) ?? '';
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      const handler = controller.prototype[name];
      if (typeof handler !== 'function') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler);
      if (typeof method !== 'number') continue;
      const path = `/${prefix}/${Reflect.getMetadata(PATH_METADATA, handler) ?? ''}`
        .replace(/\/+/g, '/')
        .replace(/\/$/, '')
        .replace(/:([^/]+)/g, '{$1}');
      const verb = RequestMethod[method]!.toLowerCase();
      const publicRoute =
        Reflect.getMetadata(PUBLIC, handler) ?? Reflect.getMetadata(PUBLIC, controller) ?? false;
      paths[path] ??= {};
      const operationId = `${controller.name}_${name}`;
      const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, name) ?? {};
      const parameters = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
        name: match[1]!,
        in: 'path',
        required: true,
        schema: { type: 'string' },
      }));
      for (const [key, value] of Object.entries(args)) {
        const data = (value as { data?: string }).data;
        if (typeof data !== 'string' || !['4', '6'].includes(key.split(':')[0]!)) continue;
        parameters.push({
          name: data,
          in: key.startsWith('4:') ? 'query' : 'header',
          required: data === 'idempotency-key',
          schema: { type: 'string' },
        });
      }
      const hasBody = Object.keys(args).some((key) => key.startsWith('3:'));
      const status = String(
        Reflect.getMetadata(HTTP_CODE_METADATA, handler) ?? (verb === 'post' ? 201 : 200),
      );
      const success = responseSchemas[operationId]
        ? response(responseSchemas[operationId]!)
        : {
            description:
              'Success. Additional response fields may be added within v1; clients must ignore unknown fields.',
          };
      paths[path][verb] = {
        operationId,
        security: publicRoute ? [] : [{ bearerSession: [] }, { webSession: [] }],
        parameters,
        ...(hasBody
          ? {
              requestBody: {
                required: true,
                content:
                  path === '/v1/media/{id}/content'
                    ? {
                        'application/octet-stream': {
                          schema: { type: 'string', format: 'binary' },
                          description:
                            'JPEG, PNG or WebP bytes, at most 5 MiB; use the media asset ID from the upload reservation.',
                        },
                      }
                    : {
                        'application/json': {
                          schema: requestSchemas[operationId]
                            ? z.toJSONSchema(requestSchemas[operationId]!, { io: 'input' })
                            : { type: 'object' },
                          ...(!requestSchemas[operationId]
                            ? {
                                description:
                                  'Domain command; field validation is defined in the owning service. See the repository runbooks for workflows and retry rules.',
                              }
                            : {}),
                        },
                      },
              },
            }
          : {}),
        responses: {
          [status]: success,
          '400': { description: 'Invalid request', content: json(apiErrorSchema) },
          '401': { description: 'Sign-in required', content: json(apiErrorSchema) },
          '403': {
            description: 'Insufficient permission or failed CSRF check',
            content: json(apiErrorSchema),
          },
          '409': { description: 'Version or state conflict', content: json(apiErrorSchema) },
          '404': { description: 'Missing or inaccessible record', content: json(apiErrorSchema) },
          '429': { description: 'Rate limit reached; honor Retry-After', content: json(apiErrorSchema) },
          '503': {
            description: 'Dependency unavailable or feature not configured',
            content: json(apiErrorSchema),
          },
        },
        ...(paths[path][verb] as object | undefined),
      };
    }
  }
  const walletRegister = paths['/v1/wallet/apple/v1/devices/{device}/registrations/{passType}/{serial}'];
  if (walletRegister?.post)
    (walletRegister.post as any).responses = {
      ...(walletRegister.post as any).responses,
      '200': { description: 'Already registered' },
      '201': { description: 'Registration created' },
    };
  const walletList = paths['/v1/wallet/apple/v1/devices/{device}/registrations/{passType}'];
  if (walletList?.get) (walletList.get as any).responses['204'] = { description: 'No updated passes' };
  const walletLog = paths['/v1/wallet/apple/v1/log'];
  if (walletLog?.post) {
    delete (walletLog.post as any).responses['201'];
    (walletLog.post as any).responses['200'] = {
      description: 'Device log acknowledged without storing sensitive contents',
    };
  }
  return {
    ...openapi,
    paths,
    components: {
      securitySchemes: {
        bearerSession: { type: 'http', scheme: 'bearer' },
        webSession: {
          type: 'apiKey',
          in: 'cookie',
          name: '__Host-clubby_session',
          description:
            'Development uses clubby_session. Unsafe web requests additionally require an allowed Origin and x-csrf-token.',
        },
      },
    },
  };
}
