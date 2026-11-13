import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

/**
 * Logins, roles and the global JWT guard. Every route needs a token unless `@Public()`.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('JWT_SECRET');
        // No fallback: a default secret would let anyone mint tokens.
        if (!secret || secret.length < 32) {
          throw new Error('JWT_SECRET must be set to at least 32 characters');
        }
        return {
          secret,
          signOptions: { expiresIn: config.get<string>('JWT_EXPIRES_IN') ?? '12h' },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, { provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AuthModule {}
