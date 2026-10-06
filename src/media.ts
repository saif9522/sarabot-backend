import * as path from 'path';

export const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads');

/** Local uploaded file path for a stored media value, or null if it is an external link. */
export function localMediaPath(media: string): string | null {
  if (/^https?:\/\//i.test(media)) return null;
  const name = path.basename(media); // never allow paths outside UPLOAD_DIR
  return name ? path.join(UPLOAD_DIR, name) : null;
}

export const ALLOWED_MIME: Record<string, { ext: string; kind: 'image' | 'document' }> = {
  'image/jpeg': { ext: '.jpg', kind: 'image' },
  'image/png': { ext: '.png', kind: 'image' },
  'image/webp': { ext: '.webp', kind: 'image' },
  'application/pdf': { ext: '.pdf', kind: 'document' },
  'application/msword': { ext: '.doc', kind: 'document' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { ext: '.docx', kind: 'document' },
  'application/vnd.ms-excel': { ext: '.xls', kind: 'document' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { ext: '.xlsx', kind: 'document' },
};

export const MIME_BY_EXT: Record<string, string> = Object.fromEntries(Object.entries(ALLOWED_MIME).map(([m, v]) => [v.ext, m]));
