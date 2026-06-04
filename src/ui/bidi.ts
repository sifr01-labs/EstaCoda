// Bidi/LTR isolation helpers for technical tokens embedded in Arabic text.
// Keep this minimal — no full bidi framework.

export const LRI = "\u2066";
export const RLI = "\u2067";
export const PDI = "\u2069";

/**
 * Wraps a value in Left-to-Right Isolate (LRI) and Pop Directional Isolate (PDI)
 * so it stays LTR-stable when embedded in RTL (Arabic) text.
 */
export function isolateLtr(value: string): string {
  return `${LRI}${value}${PDI}`;
}

/**
 * Wraps natural-language RTL text in Right-to-Left Isolate (RLI) and
 * Pop Directional Isolate (PDI) for render-time terminal stability.
 */
export function isolateRtl(value: string): string {
  return `${RLI}${value}${PDI}`;
}

export function closeOpenBidiIsolates(value: string): string {
  let openIsolates = 0;
  for (const char of value) {
    if (char === LRI || char === RLI) {
      openIsolates += 1;
    } else if (char === PDI && openIsolates > 0) {
      openIsolates -= 1;
    }
  }
  return openIsolates === 0 ? value : `${value}${PDI.repeat(openIsolates)}`;
}
