/** Turns a pasted or dropped picture file into a data URL a draft can keep. */

import { shrink } from '../images';

const KEPT = /^data:image\/(png|jpeg|webp|gif);base64,/;

/** Stays under the 6 MB a draft attachment allows. */
const MAX_LENGTH = 5_500_000;

export const pictureFiles = (list: FileList | null | undefined): File[] => [...(list ?? [])].filter((f) => f.type.startsWith('image/'));

/** An id for `att:<id>`, 10 lowercase letters and digits. */
export function newPictureId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => (b % 36).toString(36)).join('');
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('could not read the file'));
    reader.readAsDataURL(file);
  });
}

async function asWebp(dataUrl: string): Promise<string> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext('2d')!.drawImage(img, 0, 0);
  return canvas.toDataURL('image/webp', 0.85);
}

/** The file shrunk to the panel's picture size, or undefined when it cannot be kept. */
export async function preparePicture(file: File): Promise<string | undefined> {
  try {
    let data = await shrink(await readFile(file));
    if (!KEPT.test(data) || data.length > MAX_LENGTH) data = await asWebp(data);
    return KEPT.test(data) && data.length <= MAX_LENGTH ? data : undefined;
  } catch {
    return undefined;
  }
}
