import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { UPLOAD_DIR } from './media';

async function bootstrap() {
  // rawBody: needed to verify Razorpay webhook signatures
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  // Uploaded flow images/documents, e.g. http://localhost:4100/uploads/123.jpg
  app.useStaticAssets(UPLOAD_DIR, { prefix: '/uploads/', index: false, dotfiles: 'deny' });
  app.setGlobalPrefix('api');
  app.enableCors({ origin: process.env.FRONTEND_URL || 'http://localhost:3100', credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableShutdownHooks();
  const port = Number(process.env.PORT || 4100);
  await app.listen(port);
  console.log(`Sarabot API on http://localhost:${port}/api`);
}
bootstrap();
