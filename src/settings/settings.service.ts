import { Global, Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma.service';

/** Settings the Super Admin can change from the dashboard. Each falls back to the .env value. */
export const SETTING_KEYS = {
  OPENAI_API_KEY: { secret: true, label: 'OpenAI (ChatGPT) API key' },
  OPENAI_MODEL: { secret: false, label: 'OpenAI model' },
  OPENAI_FALLBACK_MODEL: { secret: false, label: 'Backup OpenAI model' },
  GEMINI_API_KEY: { secret: true, label: 'Gemini API key' },
  LLM_MODEL: { secret: false, label: 'AI model' },
  LLM_FALLBACK_MODEL: { secret: false, label: 'Backup AI models (comma separated)' },
  RAZORPAY_KEY_ID: { secret: false, label: 'Razorpay key ID' },
  RAZORPAY_KEY_SECRET: { secret: true, label: 'Razorpay key secret' },
  RAZORPAY_WEBHOOK_SECRET: { secret: true, label: 'Razorpay webhook secret' },
  ALLOW_SIGNUP: { secret: false, label: 'Allow sign-up' },
} as const;
export type SettingKey = keyof typeof SETTING_KEYS;

const encKey = () => createHash('sha256').update(`settings:${process.env.SESSION_SECRET || 'dev-only-secret-change-me-dev-only-secret'}`).digest();

function encrypt(plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', encKey(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${data.toString('base64')}`;
}
function decrypt(stored: string): string | null {
  try {
    const [, iv, tag, data] = stored.split('.');
    const d = createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null; // SESSION_SECRET changed: re-enter the value in Platform settings
  }
}

@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly log = new Logger('Settings');
  private cache = new Map<string, string>();
  constructor(private prisma: PrismaService) {}

  async onModuleInit() {
    await this.reload();
  }

  private async reload() {
    const rows = await this.prisma.setting.findMany();
    this.cache.clear();
    for (const r of rows) {
      const v = r.secret ? decrypt(r.value) : r.value;
      if (v === null) this.log.warn(`Could not read saved "${r.key}" (SESSION_SECRET changed?). Enter it again in Platform settings.`);
      else this.cache.set(r.key, v);
    }
  }

  /** Dashboard value first, then .env, then the default. */
  get(key: SettingKey, fallback = ''): string {
    const v = this.cache.get(key);
    return v !== undefined && v !== '' ? v : process.env[key] || fallback;
  }

  source(key: SettingKey): 'dashboard' | 'env' | 'unset' {
    if (this.cache.get(key)) return 'dashboard';
    return process.env[key] ? 'env' : 'unset';
  }

  async set(key: SettingKey, value: string) {
    const secret = SETTING_KEYS[key].secret;
    if (!value) {
      await this.prisma.setting.deleteMany({ where: { key } });
    } else {
      const stored = secret ? encrypt(value) : value;
      await this.prisma.setting.upsert({ where: { key }, update: { value: stored, secret }, create: { key, value: stored, secret } });
    }
    await this.reload();
  }

  /** For the admin page: secrets are never sent back, only whether they are set. */
  list() {
    return (Object.keys(SETTING_KEYS) as SettingKey[]).map((key) => {
      const { secret, label } = SETTING_KEYS[key];
      const v = this.get(key);
      return { key, label, secret, source: this.source(key), value: secret ? (v ? `••••${v.slice(-4)}` : '') : v };
    });
  }
}

@Global()
@Module({ providers: [SettingsService], exports: [SettingsService] })
export class SettingsModule {}
