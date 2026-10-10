export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Centres a window of `size` in `area`, shrinking it to fit. */
export function centredBounds(area: Rect, size: { width: number; height: number }): Rect {
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height);
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  };
}

/** The display area that contains `point`, else the nearest one. */
export function areaUnder<T extends { workArea: Rect; bounds: Rect }>(displays: T[], point: { x: number; y: number }): T {
  const inside = displays.find(
    (d) =>
      point.x >= d.bounds.x &&
      point.x < d.bounds.x + d.bounds.width &&
      point.y >= d.bounds.y &&
      point.y < d.bounds.y + d.bounds.height,
  );
  if (inside) return inside;
  const dist = (d: T) => {
    const dx = Math.max(d.bounds.x - point.x, 0, point.x - (d.bounds.x + d.bounds.width));
    const dy = Math.max(d.bounds.y - point.y, 0, point.y - (d.bounds.y + d.bounds.height));
    return dx * dx + dy * dy;
  };
  return displays.reduce((best, d) => (dist(d) < dist(best) ? d : best));
}
