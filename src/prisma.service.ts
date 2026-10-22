import { Global, Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Small column additions the code needs, applied automatically on startup so a deploy never
 * breaks just because nobody ran `prisma db push`. Each statement is safe to run again (IF NOT EXISTS).
 */
const SAFE_COLUMN_UPGRADES = [
  `ALTER TABLE "Bot" ADD COLUMN IF NOT EXISTS "language" TEXT NOT NULL DEFAULT 'auto'`,
  `ALTER TABLE "Bot" ADD COLUMN IF NOT EXISTS "welcomeMessageHi" TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE "Bot" ADD COLUMN IF NOT EXISTS "fallbackMessageHi" TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE "Bot" ADD COLUMN IF NOT EXISTS "alwaysReply" BOOLEAN NOT NULL DEFAULT true`,
  `ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "alwaysOnline" BOOLEAN NOT NULL DEFAULT false`,
];

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private readonly log = new Logger('Database');

  async onModuleInit() {
    await this.$connect();
    for (const sql of SAFE_COLUMN_UPGRADES) {
      try {
        await this.$executeRawUnsafe(sql);
      } catch (e) {
        // e.g. the "Bot" table doesn't exist yet on a brand-new database: `prisma db push` creates everything.
        this.log.warn(`Could not apply "${sql.slice(0, 70)}…": ${(e as Error).message.split('\n').pop()}`);
      }
    }
  }
}

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
