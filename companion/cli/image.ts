/** Reads image files for `draw` and `snap`: type, pixel size and data URL. */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { InputError } from './validate';

/** Raw size limit. Base64 grows it by a third, which stays under the 20 MB body limit. */
export const MAX_IMAGE_BYTES = 14 * 1024 * 1024;

export interface ImageInfo {
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  width: number;
  height: number;
}

/** Type and pixel size from the file header, or undefined for anything else. */
export function imageInfo(buf: Buffer): ImageInfo | undefined {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('ascii', 12, 16) === 'IHDR') {
    return { mimeType: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && buf.toString('ascii', 0, 4) === 'GIF8') {
    return { mimeType: 'image/gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { mimeType: 'image/webp', width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    if (chunk === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return { mimeType: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8 ') return { mimeType: 'image/webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    return undefined;
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) return jpegInfo(buf);
  return undefined;
}

/** Walks JPEG segments to the first start-of-frame marker, which holds the size. */
function jpegInfo(buf: Buffer): ImageInfo | undefined {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return undefined;
    const marker = buf[i + 1];
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return { mimeType: 'image/jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return undefined;
}

export interface LoadedImage extends ImageInfo {
  dataURL: string;
}

export async function loadImage(file: string, cwd: string): Promise<LoadedImage> {
  const full = path.resolve(cwd, file);
  let buf: Buffer;
  try {
    buf = await readFile(full);
  } catch {
    throw new InputError(`cannot read image ${file}`);
  }
  if (buf.length > MAX_IMAGE_BYTES) throw new InputError(`${file} is over ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
  const info = imageInfo(buf);
  if (!info || !info.width || !info.height) throw new InputError(`${file} is not a png, jpeg, gif or webp image`);
  return { ...info, dataURL: `data:${info.mimeType};base64,${buf.toString('base64')}` };
}

/** Board size for a picture: the given width or height with the other kept in proportion, else `fallbackWidth` wide. */
export function fitSize(info: ImageInfo, width?: number, height?: number, fallbackWidth = 720): { width: number; height: number } {
  if (width && height) return { width, height };
  const ratio = info.height / info.width;
  if (height) return { width: Math.round(height / ratio), height };
  const w = width ?? Math.min(fallbackWidth, info.width);
  return { width: w, height: Math.round(w * ratio) };
}
