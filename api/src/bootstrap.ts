import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { rateStore } from './platform/rate-limit';
import cookie from '@fastify/cookie';
import { CONFIG, readConfig, type Config } from './platform/config';
import { Database } from './platform/database';
import { ErrorFilter } from './platform/http';
import { PlatformController } from './platform/platform.controller';
import { CatalogueController } from './catalogue/catalogue.controller';
import { IdentityService } from './identity/identity.service';
import { IdentityController } from './identity/identity.controller';
import { SessionGuard } from './identity/session.guard';
import { OrganizationsService } from './organizations/organizations.service';
import { OrganizationsController } from './organizations/organizations.controller';
import { PrivacyService } from './privacy/privacy.service';
import { PrivacyController } from './privacy/privacy.controller';
import { CatalogueService } from './catalogue/catalogue.service';
import { ManagementController } from './catalogue/management.controller';
import { EventsService } from './events/events.service';
import { EventsController } from './events/events.controller';
import { ObjectStore } from './media/object-store';
import { MediaService } from './media/media.service';
import { MediaController } from './media/media.controller';
import { documentControllers } from './platform/openapi';
import { CommerceController } from './commerce/commerce.controller';
import { commerceServices } from './commerce/services';
import type { PaymentProvider } from './commerce/provider';
import { TablesController } from './tables/tables.controller';
import { GroupsController } from './groups/groups.controller';
import { TicketsController } from './tickets/tickets.controller';
import { WalletController } from './tickets/wallet.controller';
import type { WalletProvider } from './tickets/wallet-provider';
import { NotificationsController } from './notifications/notifications.controller';
import { NotificationsService } from './notifications/notifications.service';
import { EmailFeedbackService } from './notifications/email-feedback';
import type { PushProvider } from './notifications/push-provider';
import { AdministrationController } from './administration/administration.controller';
import { AdministrationService } from './administration/administration.service';
import { ReportingController } from './reporting/reporting.controller';
import { ReportingService } from './reporting/reporting.service';
import { AppleService } from './identity/apple.service';
import type { AppleProvider } from './identity/apple-provider';
import { NotificationDelivery } from './notifications/delivery';
import { AppleNotificationsService } from './identity/apple-notifications.service';
import type { JWTVerifyGetKey } from 'jose';
import { WorkspaceController } from './organizations/workspace.controller';
import { OperationsController } from './platform/operations.controller';
import { OperationsService } from './platform/operations.service';
import { BetaController } from './beta/beta.controller';
import { BetaService } from './beta/beta.service';

export async function createApplication(
  config: Config = readConfig(),
  suppliedDatabase?: Database,
  overrides: {
    objectStore?: ObjectStore;
    paymentProvider?: PaymentProvider;
    walletProvider?: WalletProvider;
    pushProvider?: PushProvider;
    appleProvider?: AppleProvider;
    appleNotificationKeys?: JWTVerifyGetKey;
  } = {},
) {
  const db = suppliedDatabase ?? new Database(config);
  const identity = new IdentityService(db, config);
  const organizations = new OrganizationsService(db, config);
  const commerce = commerceServices(db, organizations, overrides.paymentProvider, overrides.walletProvider);
  const apple = new AppleService(db, identity, overrides.appleProvider);
  const media = new MediaService(db, organizations, overrides.objectStore ?? new ObjectStore(config));
  const privacy = new PrivacyService(db, config, {
    erasePayments: (id) => commerce.savedMethods.eraseUser(id),
    revokeApple: (id) => apple.revokeUser(id),
    eraseMedia: (assetId) => media.cleanup({ assetId }),
    eraseLocalMail: (id) => new NotificationDelivery(db, config).eraseLocalUser(id),
  });
  const controllers = [
    BetaController,
    PlatformController,
    CatalogueController,
    IdentityController,
    OrganizationsController,
    WorkspaceController,
    OperationsController,
    PrivacyController,
    ManagementController,
    EventsController,
    MediaController,
    CommerceController,
    TablesController,
    GroupsController,
    TicketsController,
    WalletController,
    NotificationsController,
    AdministrationController,
    ReportingController,
  ];
  @Module({
    controllers,
    providers: [
      { provide: CONFIG, useValue: config },
      { provide: Database, useValue: db },
      { provide: BetaService, useValue: new BetaService(db) },
      { provide: IdentityService, useValue: identity },
      { provide: AppleService, useValue: apple },
      {
        provide: AppleNotificationsService,
        useValue: new AppleNotificationsService(db, privacy, overrides.appleNotificationKeys),
      },
      { provide: OrganizationsService, useValue: organizations },
      { provide: OperationsService, useValue: new OperationsService(db, organizations) },
      { provide: AdministrationService, useValue: new AdministrationService(db, organizations) },
      { provide: ReportingService, useValue: new ReportingService(db, organizations) },
      {
        provide: NotificationsService,
        useValue: new NotificationsService(db, organizations, overrides.pushProvider),
      },
      { provide: EmailFeedbackService, useValue: new EmailFeedbackService(db, organizations) },
      {
        provide: PrivacyService,
        useValue: privacy,
      },
      { provide: CatalogueService, useValue: new CatalogueService(db, organizations) },
      { provide: EventsService, useValue: new EventsService(db, organizations) },
      {
        provide: MediaService,
        useValue: media,
      },
      ...commerce.providers,
    ],
  })
  class ApplicationModule {}
  const adapter = new FastifyAdapter({
    bodyLimit: 64 * 1024,
    requestTimeout: 30_000,
    trustProxy: config.trustedProxies.length ? config.trustedProxies : false,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    logger: {
      level: config.LOG_LEVEL,
      serializers: {
        req: (req: { method?: string; id?: string }) => ({ method: req.method, id: req.id }),
        res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
      },
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    },
  });
  const app = await NestFactory.create<NestFastifyApplication>(ApplicationModule, adapter, {
    logger: false,
    rawBody: true,
  });
  adapter
    .getInstance()
    .addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: 5 * 1024 * 1024 },
      (_request, body, done) => done(null, body),
    );
  app.useGlobalFilters(new ErrorFilter());
  app.useGlobalGuards(new SessionGuard(identity));
  app.enableCors({
    origin: config.webOrigins,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: [
      'content-type',
      'authorization',
      'x-csrf-token',
      'idempotency-key',
      'x-clubby-channel',
      'x-clubby-api-version',
    ],
  });
  await app.register(helmet);
  await app.register(cookie);
  await app.register(rateLimit, {
    max: config.HTTP_RATE_LIMIT,
    timeWindow: '1 minute',
    skipOnError: false,
    ...(['staging', 'production'].includes(config.APP_ENV) ? { store: rateStore(db) } : {}),
    allowList: (request) => ['/health/live', '/health/ready'].includes(request.url.split('?')[0]!),
    errorResponseBuilder: (request) => ({
      error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.', requestId: request.id },
    }),
  });
  adapter.getInstance().addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('cache-control', 'no-store');
  });
  adapter.getInstance().addHook('onRequest', async (request, reply) => {
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      request.headers.origin &&
      !config.webOrigins.includes(request.headers.origin)
    ) {
      await reply.status(403).send({
        error: { code: 'ORIGIN_DENIED', message: 'Request origin is not allowed.', requestId: request.id },
      });
    }
  });
  app.enableShutdownHooks();
  await app.init();
  app.get(PlatformController).documentationValue = documentControllers(controllers);
  await adapter.getInstance().ready();
  return app;
}
