export type FiniteNumberCoercionOptions = {
  min?: number;
  max?: number;
  default: number;
};

export type NonNegativeIntegerCoercionOptions = {
  min?: number;
  max?: number;
  default: number;
};

export type PositiveIntegerCoercionOptions = {
  max?: number;
  default?: number;
};

export function coerceFiniteNumber(
  value: unknown,
  options: FiniteNumberCoercionOptions
): number {
  const parsed = parseFiniteNumber(value);
  const fallback = finiteOr(options.default, 0);
  return clampFinite(parsed ?? fallback, normalizeBound(options.min), normalizeBound(options.max));
}

export function coerceNonNegativeInteger(
  value: unknown,
  options: NonNegativeIntegerCoercionOptions
): number {
  const min = normalizeIntegerBound(options.min) ?? 0;
  const max = normalizeIntegerBound(options.max);
  const fallback = clampInteger(Math.trunc(finiteOr(options.default, min)), min, max);
  return clampInteger(Math.trunc(parseFiniteNumber(value) ?? fallback), min, max);
}

export function coercePositiveInteger(
  value: unknown,
  options: PositiveIntegerCoercionOptions = {}
): number {
  const max = normalizeIntegerBound(options.max);
  const fallback = clampInteger(Math.trunc(finiteOr(options.default, 1)), 1, max);
  return clampInteger(Math.trunc(parseFiniteNumber(value) ?? fallback), 1, max);
}

function parseFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return undefined;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeBound(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeIntegerBound(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function clampFinite(value: number, min: number | undefined, max: number | undefined): number {
  let result = value;
  if (min !== undefined && result < min) {
    result = min;
  }
  if (max !== undefined && result > max) {
    result = max;
  }
  return result;
}

function clampInteger(value: number, min: number, max: number | undefined): number {
  let result = value;
  if (result < min) {
    result = min;
  }
  if (max !== undefined && result > max) {
    result = max;
  }
  return result;
}
