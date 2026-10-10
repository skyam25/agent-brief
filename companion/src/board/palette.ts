import type { ColorName } from '../protocol';

export interface Swatch {
  stroke: string;
  fill: string;
}

/** Excalidraw's open-color shades: a dark stroke and a light fill per name. */
export const PALETTE: Record<ColorName, Swatch> = {
  black: { stroke: '#1e1e1e', fill: '#e9ecef' },
  gray: { stroke: '#868e96', fill: '#dee2e6' },
  red: { stroke: '#e03131', fill: '#ffc9c9' },
  orange: { stroke: '#e8590c', fill: '#ffd8a8' },
  yellow: { stroke: '#f08c00', fill: '#ffec99' },
  green: { stroke: '#2f9e44', fill: '#b2f2bb' },
  blue: { stroke: '#1971c2', fill: '#a5d8ff' },
  violet: { stroke: '#6741d9', fill: '#d0bfff' },
  pink: { stroke: '#c2255c', fill: '#fcc2d7' },
};

/** Claude draws in violet unless asked otherwise, so its marks stand apart from the user's ink. */
export const CLAUDE_COLOR: ColorName = 'violet';

export const STICKY_COLOR: ColorName = 'yellow';

/** Dark label text on sticky notes stays readable on every fill. */
export const STICKY_TEXT = PALETTE.black.stroke;

export function isColorName(value: unknown): value is ColorName {
  return typeof value === 'string' && Object.hasOwn(PALETTE, value);
}

export function swatch(name: ColorName | undefined, fallback: ColorName = CLAUDE_COLOR): Swatch {
  return PALETTE[name && isColorName(name) ? name : fallback];
}

/** Maps a hex colour back to its name when it is a palette stroke or fill. */
export function colorNameOf(hex: string | undefined): ColorName | undefined {
  if (!hex) return undefined;
  const lower = hex.toLowerCase();
  for (const [name, s] of Object.entries(PALETTE) as [ColorName, Swatch][]) {
    if (s.stroke === lower) return name;
  }
  for (const [name, s] of Object.entries(PALETTE) as [ColorName, Swatch][]) {
    if (s.fill === lower) return name;
  }
  return undefined;
}
