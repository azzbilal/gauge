import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ExpertStatus, Prisma, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from './auth.decorators';
import { LoginDto, RegisterDto } from './dto/auth.dto';
import { JwtPayload } from './jwt-auth.guard';

const BCRYPT_ROUNDS = 12;
// The Expert row behind a login is staff, not an applicant.
const STAFF_DOMAIN = 'CAD';

// Compared against when the email is unknown, so a miss costs the same time as a hit.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

export interface Session {
  accessToken: string;
  user: AuthUser;
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * Create a login and the Expert it acts as. Anyone may register as an author; only a
   * signed-in admin may hand out another role.
   */
  async register(dto: RegisterDto, caller?: AuthUser): Promise<Session> {
    const role = dto.role ?? Role.AUTHOR;
    if (role !== Role.AUTHOR && caller?.role !== Role.ADMIN) {
      throw new ForbiddenException('Only an admin can register a user with that role');
    }
    const passwordHash = await hashPassword(dto.password);
    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const expert = await tx.expert.create({
          data: { name: dto.name, domain: STAFF_DOMAIN, status: ExpertStatus.ACTIVE },
        });
        return tx.user.create({
          data: { name: dto.name, email: dto.email, passwordHash, role, expertId: expert.id },
        });
      });
      return this.session(user);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('An account with that email already exists');
      }
      throw err;
    }
  }

  async login(dto: LoginDto): Promise<Session> {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    const ok = await bcrypt.compare(dto.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) {
      throw new UnauthorizedException('Wrong email or password');
    }
    return this.session(user);
  }

  private async session(user: AuthUser & { passwordHash?: string }): Promise<Session> {
    const payload: JwtPayload = { sub: user.id };
    return {
      accessToken: await this.jwt.signAsync(payload),
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        expertId: user.expertId,
      },
    };
  }
}
