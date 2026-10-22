-- Hindi / English support for bots.
-- Easiest: run `npx prisma db push` once (adds these columns, keeps all data).
-- Or paste this into the Supabase SQL editor:

ALTER TABLE "Bot" ADD COLUMN IF NOT EXISTS "language" TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE "Bot" ADD COLUMN IF NOT EXISTS "welcomeMessageHi" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Bot" ADD COLUMN IF NOT EXISTS "fallbackMessageHi" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Bot" ADD COLUMN IF NOT EXISTS "alwaysReply" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "alwaysOnline" BOOLEAN NOT NULL DEFAULT false;
