import { Controller, Get, Inject } from '@nestjs/common';
import { bootstrapSchema } from '@clubby/contracts';
import { CONFIG, type Config } from './config';
import { Database } from './database';
import { ApiError } from './http';
import { openapi } from './openapi';
import { Public } from '../identity/session.guard';

@Controller()
@Public()
export class PlatformController {
  documentationValue: unknown = openapi;
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(Database) private readonly db: Database,
  ) {}
  @Get('health/live') live() {
    return { status: 'ok' };
  }
  @Get('v1/openapi.json') documentation() {
    return this.documentationValue;
  }
  @Get('health/ready') async ready() {
    if (!(await this.db.ready())) throw new ApiError('NOT_READY', 'Service is not ready.', 503);
    return { status: 'ready' };
  }
  @Get('v1/bootstrap') async bootstrap() {
    const settings = (
      await this.db.query(
        'SELECT banner,new_sales_paused,features,version FROM public_settings WHERE singleton=true',
      )
    ).rows[0];
    return {
      ...bootstrapSchema.parse({
        data: {
          apiVersion: 'v1',
          environment: this.config.APP_ENV,
          capabilities: {
            catalogue: true,
            nativeCheckout: this.config.STRIPE_MODE !== 'disabled' && !settings?.new_sales_paused,
            externalCheckout: true,
          },
        },
      }),
      settings: {
        banner: settings?.banner ?? '',
        newSalesPaused: settings?.new_sales_paused ?? true,
        version: settings?.version ?? 1,
        features: settings?.features ?? {},
      },
    };
  }
}
