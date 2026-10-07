import { existsSync, promises as fs } from 'fs';
import * as path from 'path';
import { PrismaService } from './prisma.service';
import { MIME_BY_EXT, UPLOAD_DIR, localMediaPath } from './media';

/** Saves an upload in the database (permanent) and on disk (fast cache). */
export async function saveMedia(prisma: PrismaService, name: string, mime: string, data: Buffer) {
  await prisma.mediaFile.upsert({ where: { name }, create: { name, mime, size: data.length, data }, update: { mime, size: data.length, data } });
  await fs.mkdir(UPLOAD_DIR, { recursive: true }).catch(() => undefined);
  await fs.writeFile(path.join(UPLOAD_DIR, name), data).catch(() => undefined);
}

/**
 * Makes sure an uploaded file is on disk, restoring it from the database after a restart wiped it.
 * Returns the local path, or null if the file doesn't exist anywhere.
 */
export async function ensureLocalMedia(prisma: PrismaService, media: string): Promise<string | null> {
  const local = localMediaPath(media);
  if (!local) return null;
  if (existsSync(local)) return local;
  const row = await prisma.mediaFile.findUnique({ where: { name: path.basename(local) } });
  if (!row) return null;
  await fs.mkdir(UPLOAD_DIR, { recursive: true }).catch(() => undefined);
  await fs.writeFile(local, Buffer.from(row.data));
  return local;
}

export const mimeOf = (name: string) => MIME_BY_EXT[path.extname(name).toLowerCase()] || 'application/octet-stream';
