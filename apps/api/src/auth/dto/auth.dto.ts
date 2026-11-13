import { BadRequestException } from '@nestjs/common';
import { Role } from '@prisma/client';

export interface LoginDto {
  email: string;
  password: string;
}

export interface RegisterDto extends LoginDto {
  name: string;
  /** Only an admin may set this; anyone else registers as an author. */
  role?: Role;
}

export const PASSWORD_MIN = 8;

function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function email(value: unknown): string {
  if (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(value.trim())) {
    throw new BadRequestException('email must be an email address');
  }
  return value.trim().toLowerCase();
}

export function parseLoginDto(body: unknown): LoginDto {
  const b = asObject(body);
  if (typeof b.password !== 'string' || !b.password) {
    throw new BadRequestException('password is required');
  }
  return { email: email(b.email), password: b.password };
}

export function parseRegisterDto(body: unknown): RegisterDto {
  const b = asObject(body);
  if (typeof b.name !== 'string' || !b.name.trim()) {
    throw new BadRequestException('name is required');
  }
  if (typeof b.password !== 'string' || b.password.length < PASSWORD_MIN) {
    throw new BadRequestException(`password must be at least ${PASSWORD_MIN} characters`);
  }
  let role: Role | undefined;
  if (b.role !== undefined && b.role !== null) {
    const r = typeof b.role === 'string' ? b.role.toUpperCase() : '';
    if (!(Object.values(Role) as string[]).includes(r)) {
      throw new BadRequestException(`role must be one of ${Object.values(Role).join(', ').toLowerCase()}`);
    }
    role = r as Role;
  }
  return { name: b.name.trim(), email: email(b.email), password: b.password, role };
}
