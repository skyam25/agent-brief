/** Keeps pictures Claude draws small enough to store in a board file. */

import type { DrawRequest } from '../protocol';

/** Longest edge, in pixels, of a picture kept on a board. */
export const IMAGE_MAX_EDGE = 1600;

function load(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(Object.assign(new Error('could not decode the image'), { code: 'bad_request' }));
    img.src = src;
  });
}

/** Scales a data URL down to IMAGE_MAX_EDGE. Smaller pictures pass through unchanged. */
export async function shrink(dataURL: string): Promise<string> {
  const img = await load(dataURL);
  const edge = Math.max(img.naturalWidth, img.naturalHeight);
  if (edge <= IMAGE_MAX_EDGE) return dataURL;
  const scale = IMAGE_MAX_EDGE / edge;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/webp', 0.9);
}

/** The request with every image shrunk. */
export async function shrinkImages(req: DrawRequest): Promise<DrawRequest> {
  if (!req?.elements?.some((e) => e.type === 'image')) return req;
  const elements = await Promise.all(
    req.elements.map(async (e) => (e.type === 'image' && e.image ? { ...e, image: await shrink(e.image) } : e)),
  );
  return { ...req, elements };
}

/** The request as text for font loading, without the image data. */
export function textOf(req: unknown): string {
  return JSON.stringify(req, (key, value) => (key === 'image' ? undefined : value));
}
