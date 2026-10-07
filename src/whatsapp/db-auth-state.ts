import { AuthenticationCreds, AuthenticationState, BufferJSON, SignalDataTypeMap, initAuthCreds, proto } from '@whiskeysockets/baileys';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { existsSync, promises as fs } from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma.service';

/**
 * WhatsApp login kept in Postgres instead of files.
 * Files on Render's free plan are wiped on every deploy, restart and wake-up, which unlinked the number.
 * The database survives all of that, so the number stays linked until the user presses Unlink.
 * Values are encrypted (AES-256-GCM) with a key derived from SESSION_SECRET.
 */

const key = () => createHash('sha256').update(`wa-auth:${process.env.SESSION_SECRET || 'dev-only-secret-change-me-dev-only-secret'}`).digest();

function encrypt(plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${data.toString('base64')}`;
}
function decrypt(stored: string): string | null {
  try {
    const [, iv, tag, data] = stored.split('.');
    const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null; // SESSION_SECRET changed: the number has to be linked again
  }
}

const pack = (v: unknown) => encrypt(JSON.stringify(v, BufferJSON.replacer));
const unpack = (s: string) => {
  const raw = decrypt(s);
  return raw === null ? null : JSON.parse(raw, BufferJSON.reviver);
};

/** True if this account has a saved login. */
export async function hasDbCreds(prisma: PrismaService, accountId: string) {
  return !!(await prisma.waAuth.findUnique({ where: { accountId_key: { accountId, key: 'creds' } }, select: { key: true } }));
}

export async function clearDbAuth(prisma: PrismaService, accountId: string) {
  await prisma.waAuth.deleteMany({ where: { accountId } });
}

/** One-time move of an old file-based login (from before this change) into the database. */
export async function importFileAuth(prisma: PrismaService, accountId: string, dir: string) {
  if (!existsSync(path.join(dir, 'creds.json')) || (await hasDbCreds(prisma, accountId))) return false;
  const files = await fs.readdir(dir);
  const rows: { accountId: string; key: string; value: string }[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const raw = await fs.readFile(path.join(dir, f), 'utf8').catch(() => null);
    if (!raw) continue;
    const k = f === 'creds.json' ? 'creds' : f.slice(0, -5).replace(/__/g, '/'); // file names are "<type>-<id>.json"
    rows.push({ accountId, key: k, value: encrypt(raw) }); // raw is already BufferJSON text
  }
  if (rows.length) await prisma.$transaction(rows.map((r) => prisma.waAuth.upsert({ where: { accountId_key: { accountId, key: r.key } }, create: r, update: { value: r.value } })));
  return rows.length > 0;
}

/** Drop-in replacement for Baileys' useMultiFileAuthState. */
export async function useDbAuthState(prisma: PrismaService, accountId: string): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const read = async (k: string) => {
    const row = await prisma.waAuth.findUnique({ where: { accountId_key: { accountId, key: k } } });
    return row ? unpack(row.value) : null;
  };
  const creds: AuthenticationCreds = (await read('creds')) || initAuthCreds();

  // Baileys can write keys from several events at once; run writes one after another.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = (job: () => Promise<unknown>) => (queue = queue.then(job, job));

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const out: { [id: string]: SignalDataTypeMap[T] } = {};
          if (!ids.length) return out;
          const rows = await prisma.waAuth.findMany({ where: { accountId, key: { in: ids.map((id) => `${type}-${id}`) } } });
          const byKey = new Map<string, string>(rows.map((r: { key: string; value: string }) => [r.key, r.value]));
          for (const id of ids) {
            const stored = byKey.get(`${type}-${id}`);
            let value = stored ? unpack(stored) : null;
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            if (value) out[id] = value;
          }
          return out;
        },
        set: async (data: any) => {
          const upserts: { key: string; value: string }[] = [];
          const deletes: string[] = [];
          for (const type of Object.keys(data)) {
            for (const id of Object.keys(data[type] || {})) {
              const v = data[type][id];
              const k = `${type}-${id}`;
              if (v) upserts.push({ key: k, value: pack(v) });
              else deletes.push(k);
            }
          }
          await enqueue(() => prisma.$transaction([
            ...upserts.map((u) => prisma.waAuth.upsert({ where: { accountId_key: { accountId, key: u.key } }, create: { accountId, ...u }, update: { value: u.value } })),
            ...(deletes.length ? [prisma.waAuth.deleteMany({ where: { accountId, key: { in: deletes } } })] : []),
          ]));
        },
      },
    },
    saveCreds: async () => {
      const value = pack(creds);
      await enqueue(() => prisma.waAuth.upsert({ where: { accountId_key: { accountId, key: 'creds' } }, create: { accountId, key: 'creds', value }, update: { value } }));
    },
  };
}

/** Accounts whose WhatsApp login is complete (QR scanned), so they should always be connected. */
export async function linkedAccountIds(prisma: PrismaService): Promise<string[]> {
  const rows = await prisma.waAuth.findMany({ where: { key: 'creds' }, select: { accountId: true, value: true } });
  return rows.filter((r) => (unpack(r.value) as AuthenticationCreds | null)?.registered).map((r) => r.accountId);
}
