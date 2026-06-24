export type Point = {
  x: number;
  y: number;
};

export type Size = {
  width: number;
  height: number;
};

export type Rectangle = Point & Size;

export type Edges = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export function edges(all: number): Edges;
export function edges(vertical: number, horizontal: number): Edges;
export function edges(top: number, right: number, bottom: number, left: number): Edges;
export function edges(a: number, b?: number, c?: number, d?: number): Edges {
  if (b === undefined) return { top: a, right: a, bottom: a, left: a };
  if (c === undefined) return { top: a, right: b, bottom: a, left: b };
  return { top: a, right: b, bottom: c, left: d! };
}

export const ZERO_EDGES: Edges = { top: 0, right: 0, bottom: 0, left: 0 };

export function addEdges(a: Edges, b: Edges): Edges {
  return {
    top: a.top + b.top,
    right: a.right + b.right,
    bottom: a.bottom + b.bottom,
    left: a.left + b.left,
  };
}

export function resolveEdges(partial?: Partial<Edges>): Edges {
  return {
    top: partial?.top ?? 0,
    right: partial?.right ?? 0,
    bottom: partial?.bottom ?? 0,
    left: partial?.left ?? 0,
  };
}

export function normalizeRect(rect: Rectangle): Rectangle {
  const x = rect.width < 0 ? rect.x + rect.width : rect.x;
  const y = rect.height < 0 ? rect.y + rect.height : rect.y;
  return {
    x,
    y,
    width: Math.abs(rect.width),
    height: Math.abs(rect.height),
  };
}

export function rectRight(rect: Rectangle): number {
  return rect.x + rect.width;
}

export function rectBottom(rect: Rectangle): number {
  return rect.y + rect.height;
}

export function isEmptyRect(rect: Rectangle): boolean {
  return rect.width <= 0 || rect.height <= 0;
}

export function containsPoint(rect: Rectangle, point: Point): boolean {
  const normalized = normalizeRect(rect);
  return (
    point.x >= normalized.x &&
    point.y >= normalized.y &&
    point.x < rectRight(normalized) &&
    point.y < rectBottom(normalized)
  );
}

export function containsRect(outer: Rectangle, inner: Rectangle): boolean {
  const a = normalizeRect(outer);
  const b = normalizeRect(inner);
  return b.x >= a.x && b.y >= a.y && rectRight(b) <= rectRight(a) && rectBottom(b) <= rectBottom(a);
}

export function intersectRect(a: Rectangle, b: Rectangle): Rectangle | null {
  const left = Math.max(normalizeRect(a).x, normalizeRect(b).x);
  const top = Math.max(normalizeRect(a).y, normalizeRect(b).y);
  const right = Math.min(rectRight(normalizeRect(a)), rectRight(normalizeRect(b)));
  const bottom = Math.min(rectBottom(normalizeRect(a)), rectBottom(normalizeRect(b)));
  const intersection = { x: left, y: top, width: right - left, height: bottom - top };
  return isEmptyRect(intersection) ? null : intersection;
}

export function unionRect(a: Rectangle, b: Rectangle): Rectangle {
  const normalizedA = normalizeRect(a);
  const normalizedB = normalizeRect(b);
  const left = Math.min(normalizedA.x, normalizedB.x);
  const top = Math.min(normalizedA.y, normalizedB.y);
  const right = Math.max(rectRight(normalizedA), rectRight(normalizedB));
  const bottom = Math.max(rectBottom(normalizedA), rectBottom(normalizedB));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function clamp(value: number, min?: number, max?: number): number {
  if (min !== undefined && value < min) return min;
  if (max !== undefined && value > max) return max;
  return value;
}

export function clampPoint(point: Point, bounds: Rectangle): Point {
  const normalized = normalizeRect(bounds);
  return {
    x: clamp(point.x, normalized.x, rectRight(normalized) - 1),
    y: clamp(point.y, normalized.y, rectBottom(normalized) - 1),
  };
}

export function clampRect(rect: Rectangle, bounds: Rectangle | Size): Rectangle {
  const normalized = normalizeRect(rect);
  const boundary = "x" in bounds ? normalizeRect(bounds) : { x: 0, y: 0, width: bounds.width, height: bounds.height };
  const left = clamp(normalized.x, boundary.x, rectRight(boundary));
  const top = clamp(normalized.y, boundary.y, rectBottom(boundary));
  const right = clamp(rectRight(normalized), boundary.x, rectRight(boundary));
  const bottom = clamp(rectBottom(normalized), boundary.y, rectBottom(boundary));
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export function withinBounds(size: Size, point: Point): boolean {
  return containsPoint({ x: 0, y: 0, width: size.width, height: size.height }, point);
}
