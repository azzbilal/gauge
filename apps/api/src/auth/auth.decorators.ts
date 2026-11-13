import { ExecutionContext, SetMetadata, createParamDecorator } from '@nestjs/common';
import { Role } from '@prisma/client';

/** The signed-in user as the guard loaded it from the database on this request. */
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** The designated lead: may adjudicate a split nobody independent can (docs/pipeline.md §2.1). */
  isLead: boolean;
  /** The Expert row this login acts as: tasks, reviews and events point here. */
  expertId: string;
}

export const IS_PUBLIC = 'auth:public';
export const ROLES = 'auth:roles';

/** No login required. A token that is present is still read, so `@CurrentUser()` may be set. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Only these roles may call the route. ADMIN always may. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

/** The request's user. `undefined` only on a public route called without a token. */
export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser | undefined => ctx.switchToHttp().getRequest().user,
);
