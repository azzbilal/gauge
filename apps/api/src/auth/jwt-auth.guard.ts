import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, IS_PUBLIC, ROLES } from './auth.decorators';

export interface JwtPayload {
  sub: string; // User id
}

/**
 * Global guard: every route needs a valid `Authorization: Bearer <jwt>` unless it is
 * `@Public()`. The user is re-read from the database on each request, so a deleted user
 * or a changed role takes effect at once rather than when the token expires.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets) ?? false;
    const request = ctx.switchToHttp().getRequest();

    const token = bearer(request.headers?.authorization);
    if (!token) {
      if (isPublic) return true;
      throw new UnauthorizedException('Sign in required');
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Session is invalid or expired, sign in again');
    }
    // Outside the try: a database that is down is a 5xx, not a reason to sign everyone out.
    const user: AuthUser | null = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, name: true, email: true, role: true, isLead: true, expertId: true },
    });
    // A bad token is refused even on a public route: the client believes it is signed in.
    if (!user) {
      throw new UnauthorizedException('Session is invalid or expired, sign in again');
    }
    request.user = user;

    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, targets);
    if (roles && roles.length > 0 && user.role !== Role.ADMIN && !roles.includes(user.role)) {
      throw new ForbiddenException(
        `This needs the ${roles.map((r) => r.toLowerCase()).join(' or ')} role; you are ${user.role.toLowerCase()}`,
      );
    }
    return true;
  }
}

function bearer(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value.trim() : null;
}
