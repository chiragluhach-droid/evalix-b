import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const UPLOAD_DIR = path.resolve('uploads/frames');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Saves a base64 data URL (image/jpeg or png) and returns the absolute file path.
export function saveDataUrl(dataUrl, prefix = 'frame') {
  const m = /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/.exec(dataUrl || '');
  if (!m) throw new Error('Invalid image');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 3 * 1024 * 1024) throw new Error('Image too large');
  const file = path.join(UPLOAD_DIR, `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.jpg`);
  fs.writeFileSync(file, buf);
  return file;
}
