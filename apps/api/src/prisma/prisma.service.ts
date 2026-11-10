import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Thin NestJS wrapper around PrismaClient. Boots the app even when PostgreSQL
 * is not reachable, so the API stays up and the /health endpoint can report it.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  connected = false;

  async onModuleInit() {
    try {
      await this.$connect();
      this.connected = true;
      this.logger.log('Connected to PostgreSQL');
    } catch (err) {
      this.connected = false;
      this.logger.warn(
        `Could not connect to PostgreSQL (continuing without DB): ${(err as Error).message}`,
      );
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
