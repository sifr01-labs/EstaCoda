const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Returns decoded segments for a reviewed JSON Pointer pattern. `*` is allowed
 * only as an array-item segment; callers must verify that against the value or
 * schema they traverse.
 */
export function parseProtectedArgumentPattern(pattern: string): readonly string[] | undefined {
  if (typeof pattern !== "string" || !pattern.startsWith("/") || pattern === "/") return undefined;
  const encoded = pattern.slice(1).split("/");
  const segments: string[] = [];
  for (const segment of encoded) {
    if (segment.length === 0 || /~(?:[^01]|$)/u.test(segment)) return undefined;
    const decoded = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (decoded.length === 0 || FORBIDDEN_SEGMENTS.has(decoded)) return undefined;
    if (decoded !== "*" && !/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(decoded)) return undefined;
    segments.push(decoded);
  }
  return segments;
}

export function isProtectedArgumentPattern(pattern: string): boolean {
  return parseProtectedArgumentPattern(pattern) !== undefined;
}

/** Matches a concrete pointer while ensuring wildcards bind array indices only. */
export function matchesProtectedArgumentPattern(
  pattern: string,
  pointer: string,
  root: unknown
): boolean {
  const patternSegments = parseProtectedArgumentPattern(pattern);
  const pointerSegments = parseConcretePointer(pointer);
  if (!segmentsMatch(patternSegments, pointerSegments)) {
    return false;
  }
  let current = root;
  for (let index = 0; index < patternSegments.length; index += 1) {
    const expected = patternSegments[index];
    const actual = pointerSegments![index]!;
    if (Array.isArray(current)) {
      if (expected !== "*" || !/^(?:0|[1-9][0-9]*)$/u.test(actual)) return false;
      const itemIndex = Number(actual);
      if (!Number.isSafeInteger(itemIndex) || itemIndex >= current.length) return false;
      current = current[itemIndex];
      continue;
    }
    if (!isObjectRecord(current) || expected === "*" || expected !== actual || !Object.hasOwn(current, actual)) {
      return false;
    }
    current = current[actual];
  }
  return true;
}

/** Syntactic matcher for re-verifying a concrete destination without its payload. */
export function matchesProtectedArgumentPointer(pattern: string, pointer: string): boolean {
  return segmentsMatch(parseProtectedArgumentPattern(pattern), parseConcretePointer(pointer));
}

export function getAtProtectedArgumentPointer(root: unknown, pointer: string): unknown {
  const segments = parseConcretePointer(pointer);
  if (segments === undefined) return undefined;
  let current = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(segment)) return undefined;
      current = current[Number(segment)];
    } else if (isObjectRecord(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

export function setAtProtectedArgumentPointer(root: unknown, pointer: string, value: string): void {
  const segments = parseConcretePointer(pointer);
  if (segments === undefined) throw new Error("Protected argument pointer is invalid.");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(segment)) throw new Error("Protected argument pointer changed before dispatch.");
      current = current[Number(segment)];
    } else if (isObjectRecord(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
    } else {
      throw new Error("Protected argument pointer changed before dispatch.");
    }
  }
  const leaf = segments.at(-1)!;
  if (Array.isArray(current)) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(leaf) || Number(leaf) >= current.length) {
      throw new Error("Protected argument pointer changed before dispatch.");
    }
    current[Number(leaf)] = value;
  } else if (isObjectRecord(current) && Object.hasOwn(current, leaf)) {
    current[leaf] = value;
  } else {
    throw new Error("Protected argument pointer changed before dispatch.");
  }
}

export function findProtectedArgumentEnvelopes(root: unknown): readonly { pointer: string; envelope: Record<string, unknown> }[] {
  const found: Array<{ pointer: string; envelope: Record<string, unknown> }> = [];
  const seen = new WeakSet<object>();
  const visit = (value: unknown, segments: readonly string[]): void => {
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);
    if (isObjectRecord(value) && isObjectRecord(value.protectedInput)) {
      found.push({ pointer: encodePointer(segments), envelope: value.protectedInput });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, [...segments, String(index)]));
      return;
    }
    for (const [key, entry] of Object.entries(value)) visit(entry, [...segments, key]);
  };
  visit(root, []);
  return found;
}

function parseConcretePointer(pointer: string): readonly string[] | undefined {
  if (typeof pointer !== "string" || !pointer.startsWith("/") || pointer === "/") return undefined;
  const segments: string[] = [];
  for (const segment of pointer.slice(1).split("/")) {
    if (segment.length === 0 || /~(?:[^01]|$)/u.test(segment)) return undefined;
    const decoded = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (decoded.length === 0 || decoded === "*" || FORBIDDEN_SEGMENTS.has(decoded)) return undefined;
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(decoded) && !/^(?:0|[1-9][0-9]*)$/u.test(decoded)) return undefined;
    segments.push(decoded);
  }
  return segments;
}

function encodePointer(segments: readonly string[]): string {
  return `/${segments.map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

function segmentsMatch(
  patternSegments: readonly string[] | undefined,
  pointerSegments: readonly string[] | undefined
): patternSegments is readonly string[] {
  return patternSegments !== undefined && pointerSegments !== undefined && patternSegments.length === pointerSegments.length &&
    patternSegments.every((segment, index) => segment === pointerSegments[index] ||
      (segment === "*" && /^(?:0|[1-9][0-9]*)$/u.test(pointerSegments[index]!)));
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
