import { SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IdentityService, type IdentityRequest } from './identity.service';

export const PUBLIC = Symbol('public-route');
export const Public = () => SetMetadata(PUBLIC, true);
export class SessionGuard implements CanActivate {
  constructor(
    private readonly identity: IdentityService,
    private readonly reflector = new Reflector(),
  ) {}
  async canActivate(context: ExecutionContext) {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, [context.getHandler(), context.getClass()]))
      return true;
    const request = context.switchToHttp().getRequest<IdentityRequest>();
    request.principal = await this.identity.authenticate(request);
    return true;
  }
}
