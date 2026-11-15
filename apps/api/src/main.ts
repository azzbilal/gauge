import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { trustProxySetting } from './auth/rate-limit.guard';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const trustProxy = trustProxySetting(process.env.TRUST_PROXY);
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy);
  app.enableCors();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`Gauge API listening on http://localhost:${port}`);
}
void bootstrap();
