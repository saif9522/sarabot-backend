import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { UPLOAD_DIR } from './media';

async function bootstrap() {
  // rawBody: needed to verify Razorpay webhook signatures
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });

  // Render (and most hosts) put a proxy in front of the app. Trust it so rate limits see each
  // visitor's real IP instead of the proxy's one IP. TRUST_PROXY = number of proxy hops (default 1).
  app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));
  app.disable('x-powered-by');

  // Basic security headers on every response (API and uploaded files).
  app.use((req: any, res: any, next: () => void) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); // a file is never run as a different type
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (!req.path?.startsWith('/uploads/')) res.setHeader('Cache-Control', 'no-store'); // API answers hold private data
    next();
  });
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
