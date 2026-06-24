import { stringWidth } from "./stringWidth.js";

const MAX_CACHE_SIZE = 4096;
const cache = new Map<string, number>();

export function lineWidth(line: string): number {
  const cached = cache.get(line);
  if (cached !== undefined) return cached;

  const width = stringWidth(line);
  if (cache.size >= MAX_CACHE_SIZE) cache.clear();
  cache.set(line, width);
  return width;
}

export function clearLineWidthCache(): void {
  cache.clear();
}

export function lineWidthCacheSize(): number {
  return cache.size;
}
