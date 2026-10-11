import { describe, expect, it } from 'vitest';
import { fitSize, imageInfo } from './image';

describe('imageInfo', () => {
  it('reads PNG, GIF, JPEG and WebP sizes', () => {
    const png = Buffer.alloc(24);
    png.writeUInt32BE(0x89504e47, 0);
    png.write('IHDR', 12, 'ascii');
    png.writeUInt32BE(1440, 16);
    png.writeUInt32BE(900, 20);
    expect(imageInfo(png)).toEqual({ mimeType: 'image/png', width: 1440, height: 900 });

    const gif = Buffer.from('GIF89a\x40\x01\xf0\x00', 'latin1');
    expect(imageInfo(gif)).toEqual({ mimeType: 'image/gif', width: 320, height: 240 });

    // SOI, an APP0 segment of 4 bytes, then SOF0 with height 600 and width 800.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03]);
    expect(imageInfo(jpeg)).toEqual({ mimeType: 'image/jpeg', width: 800, height: 600 });

    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'ascii');
    webp.write('WEBPVP8X', 8, 'ascii');
    webp.writeUIntLE(1279, 24, 3);
    webp.writeUIntLE(719, 27, 3);
    expect(imageInfo(webp)).toEqual({ mimeType: 'image/webp', width: 1280, height: 720 });
  });

  it('returns undefined for other files', () => {
    expect(imageInfo(Buffer.from('hello world, not an image'))).toBeUndefined();
  });
});

describe('fitSize', () => {
  const info = { mimeType: 'image/png' as const, width: 1600, height: 1000 };

  it('keeps proportions from a width or a height', () => {
    expect(fitSize(info, 800)).toEqual({ width: 800, height: 500 });
    expect(fitSize(info, undefined, 250)).toEqual({ width: 400, height: 250 });
    expect(fitSize(info, 300, 300)).toEqual({ width: 300, height: 300 });
  });

  it('defaults to 720 wide, never wider than the picture', () => {
    expect(fitSize(info)).toEqual({ width: 720, height: 450 });
    expect(fitSize({ ...info, width: 400, height: 200 })).toEqual({ width: 400, height: 200 });
  });
});
