import { QUOTED_CREDENTIAL_VALUE_PATTERN, redactKnownCredentialValues, redactSensitiveText } from "../utils/redaction.js";
import { parseProtectedArgumentPattern } from "./protected-argument-path.js";

export type PlaintextCredentialKind =
  | "api-key"
  | "client-secret"
  | "access-token"
  | "password"
  | "private-key"
  | "generic-secret";

export type PlaintextCredentialInspection = {
  detected: boolean;
  kinds: PlaintextCredentialKind[];
  redactedText: string;
};

export type PlaintextCredentialInterception = {
  kinds: PlaintextCredentialKind[];
  projectedText: string;
};

const CREDENTIAL_LABEL = String.raw`(?:and[\s_-]+)?(?:(?:consumer|client|api|access|refresh|private|public)[\s_-]+)?(?:api[\s_-]+)?(?:key|secret|token|password|passwd|passcode|credential)`;
const LABEL_ONLY_PATTERN = new RegExp(String.raw`^\s*(?:[-*]\s*)?(${CREDENTIAL_LABEL})\s*[:=]?\s*$`, "iu");
const INLINE_LABEL_PATTERN = new RegExp(String.raw`^(\s*(?:[-*]\s*)?(${CREDENTIAL_LABEL})\s*[:=]\s*)(.+?)\s*$`, "iu");
const LABELLED_VALUE_PATTERN = new RegExp(String.raw`(^|[\r\n])([ \t]*(?:[-*][ \t]*)?${CREDENTIAL_LABEL}[ \t]*(?:[:=]\s*|(?:\r\n|[\r\n])\s*))(?!${CREDENTIAL_LABEL}[ \t]*(?:[\r\n]|$))(${QUOTED_CREDENTIAL_VALUE_PATTERN}|[^\r\n]+)`, "giu");
const TABLE_LABEL_PATTERN = new RegExp(String.raw`^(${CREDENTIAL_LABEL})$`, "iu");
const PLACEHOLDER_PATTERN = /^(?:\[?(?:redacted|protected(?:_input|_value)?|hidden)\]?|<[^>]+>|\$\{[^}]+\}|process\.env\.[A-Z0-9_]+|(?:your|example|sample|test|dummy)[_-].*)$/iu;

/**
 * Finds explicit credential-shaped assignments and label/value blocks without
 * retaining or returning the detected values. This is deliberately narrower
 * than a general high-entropy scanner to avoid treating ordinary source code,
 * identifiers, and prose as credential submissions.
 */
export function inspectPlaintextCredentials(input: string): PlaintextCredentialInspection {
  const kinds = new Set<PlaintextCredentialKind>();
  let detected = false;
  const submittedValues = new Set<string>();
  // Explicit line labels delimit an unquoted passphrase at the end of the
  // line. Quoted values share the multiline parser used by text redaction.
  const prepared = input.replace(LABELLED_VALUE_PATTERN, (match, separator: string, prefix: string, value: string) => {
    if (!looksLikeLabelledValue(value) || /^-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/u.test(value)) return match;
    detected = true;
    kinds.add(kindForLabel(prefix));
    const quote = /^["'`]/u.test(value) ? value[0]! : undefined;
    submittedValues.add(quote === undefined ? value.trim() : value.slice(1, value.endsWith(quote) ? -1 : undefined));
    if (quote === '"') {
      try { submittedValues.add(JSON.parse(value) as string); }
      catch { /* Incomplete values remain masked. */ }
    }
    return `${separator}${prefix}[REDACTED]`;
  });
  const baseline = redactSensitiveText(prepared);
  if (baseline !== prepared && !containsOnlyPlaceholderAssignments(prepared)) {
    detected = true;
    collectKindsFromText(prepared, kinds);
  }

  // Baseline redaction can collapse quoted multiline values. Work on its own
  // lines so subsequent label/table edits cannot restore already masked text.
  const originalLines = baseline.split(/\r\n|[\r\n]/u);
  const redactedLines = [...originalLines];
  // Terminal paste blocks may contain CR-only line endings and no per-value
  // labels. Require an explicit submission cue, not merely credential prose.
  for (let submission = 0; submission < originalLines.length; submission++) {
    if (!/\b(?:here (?:are|is)|these are|this is) (?:the |my |our )?(?:(?:api|client|consumer) )?(?:key|secret|token|password|credentials?)\b/iu.test(originalLines[submission]!)) continue;
    for (let index = submission + 1; index < originalLines.length; index += 1) {
      const line = originalLines[index]!.trim();
      if (line === "" || /^\[Pasted text(?:\s+\d+)?\]$/iu.test(line) || /^```\w*$/u.test(line) || PLACEHOLDER_PATTERN.test(line)) continue;
      if (!looksLikeSubmittedValue(line)) break;
      detected = true;
      kinds.add("generic-secret");
      submittedValues.add(unquote(line));
      redactedLines[index] = "[REDACTED]";
    }
  }
  for (let index = 0; index < originalLines.length; index += 1) {
    const originalLine = originalLines[index] ?? "";
    const inline = INLINE_LABEL_PATTERN.exec(originalLine);
    if (inline !== null && looksLikeLabelledValue(inline[3] ?? "")) {
      detected = true;
      kinds.add(kindForLabel(inline[2] ?? ""));
      submittedValues.add(unquote(inline[3]!));
      redactedLines[index] = `${inline[1]}[REDACTED]`;
      continue;
    }

    const label = LABEL_ONLY_PATTERN.exec(originalLine);
    if (label !== null) {
      const valueIndex = nextNonEmptyLine(originalLines, index + 1);
      if (valueIndex !== undefined && looksLikeLabelledValue(originalLines[valueIndex] ?? "")) {
        detected = true;
        kinds.add(kindForLabel(label[1] ?? ""));
        submittedValues.add(unquote(originalLines[valueIndex]!));
        redactedLines[valueIndex] = preserveIndent(originalLines[valueIndex] ?? "", "[REDACTED]");
      }
    }

    const table = redactCredentialTableRow(redactedLines[index]!, submittedValues);
    if (table !== undefined) {
      detected = true;
      for (const kind of table.kinds) kinds.add(kind);
      redactedLines[index] = table.text;
    }
  }

  if (detected && kinds.size === 0) kinds.add("generic-secret");
  return {
    detected,
    kinds: [...kinds],
    redactedText: redactKnownCredentialValues(redactedLines.join("\n"), submittedValues)
  };
}

/**
 * Converts a plaintext credential submission into model-safe task input. The
 * original values must be discarded by the caller and collected again through
 * the protected-input boundary.
 */
export function interceptPlaintextCredentialInput(input: string): PlaintextCredentialInterception | undefined {
  const inspection = inspectPlaintextCredentials(input);
  if (!inspection.detected) return undefined;
  const labels = inspection.kinds.map(displayKind).join(", ");
  return {
    kinds: inspection.kinds,
    projectedText: [
      inspection.redactedText,
      "",
      `The user attempted to submit plaintext credentials (${labels}).`,
      "EstaCoda withheld the values from this task context.",
      "Continue using the remaining task context. Only if a withheld value is needed, request it through the configured protected-input tool argument flow; do not ask for or repeat credentials in ordinary chat."
    ].join("\n")
  };
}

/** Recollect clearly secret literals at reviewed destinations, without guessing
 * their meaning or passing the model's value to the secure-input callback.
 * Ordinary variables and references remain valid string arguments. */
export function protectPlaintextToolArguments(
  input: Record<string, unknown>,
  declaredPaths: readonly string[]
): Record<string, unknown> | undefined {
  if (declaredPaths.length === 0) return undefined;
  const replacements: Array<{ segments: string[]; envelope: Record<string, unknown> }> = [];
  const visit = (value: unknown, pattern: readonly string[], segments: string[], parent?: Record<string, unknown>): void => {
    if (pattern.length === 0 && typeof value === "string") {
      const field = segments.at(-1) ?? "";
      const label = [field, parent?.key, parent?.name].filter((entry) => typeof entry === "string").join(" ")
        .replace(/([a-z])([A-Z])/gu, "$1 $2");
      const secret = parent?.type === "secret" ||
        /(?:^|[\s_-])(?:key|secret|token|password|passwd|passcode|credential)(?:$|[\s_-])/iu.test(label);
      if (!secret || value.trim() === "" || PLACEHOLDER_PATTERN.test(value.trim()) || /^\{\{[^{}]+\}\}$/u.test(value.trim())) return;
      const name = [parent?.key, parent?.name, field].find((entry) =>
        typeof entry === "string" && /^[A-Za-z_][A-Za-z0-9_-]{0,79}$/u.test(entry)
      );
      replacements.push({ segments, envelope: { protectedInput: { kind: "generic-secret", purpose: `Provide the protected value for ${name ?? "this destination"}. Confirm its meaning; do not infer it from pasted text.` } } });
      return;
    }
    if (pattern.length === 0 || value === null || typeof value !== "object") return;
    const [next, ...rest] = pattern;
    if (Array.isArray(value)) {
      if (next === "*") value.forEach((entry, index) => visit(entry, rest, [...segments, String(index)]));
      return;
    }
    const record = value as Record<string, unknown>;
    if (next !== "*" && Object.hasOwn(record, next!)) visit(record[next!], rest, [...segments, next!], record);
  };
  // Walk only reviewed destinations, not arbitrary tool payloads or artifacts.
  for (const path of declaredPaths) {
    const pattern = parseProtectedArgumentPattern(path);
    if (pattern !== undefined) visit(input, pattern, []);
  }
  if (replacements.length === 0) return undefined;
  const projected = structuredClone(input);
  for (const { segments, envelope } of replacements) {
    let parent = projected;
    for (const segment of segments.slice(0, -1)) parent = parent[segment] as Record<string, unknown>;
    parent[segments.at(-1)!] = envelope;
  }
  return projected;
}

function collectKindsFromText(text: string, kinds: Set<PlaintextCredentialKind>): void {
  const labels = text.match(new RegExp(CREDENTIAL_LABEL, "giu")) ?? [];
  for (const label of labels) kinds.add(kindForLabel(label));
}

function kindForLabel(label: string): PlaintextCredentialKind {
  const normalized = label.toLocaleLowerCase("en-US");
  if (/password|passwd|passcode/u.test(normalized)) return "password";
  if (/private\s+key/u.test(normalized)) return "private-key";
  if (/access|refresh|token/u.test(normalized)) return "access-token";
  if (/consumer|client/u.test(normalized) && /secret/u.test(normalized)) return "client-secret";
  if (/key/u.test(normalized)) return "api-key";
  return "generic-secret";
}

function displayKind(kind: PlaintextCredentialKind): string {
  switch (kind) {
    case "api-key": return "API key";
    case "client-secret": return "client secret";
    case "access-token": return "access token";
    case "password": return "password";
    case "private-key": return "private key";
    case "generic-secret": return "secret";
  }
}

function nextNonEmptyLine(lines: readonly string[], start: number): number | undefined {
  for (let index = start; index < lines.length; index += 1) {
    if ((lines[index] ?? "").trim().length > 0) return index;
  }
  return undefined;
}

function looksLikeSubmittedValue(value: string): boolean {
  const normalized = unquote(value);
  if (normalized.length < 8) return false;
  if (PLACEHOLDER_PATTERN.test(normalized)) return false;
  return !/\s/u.test(normalized) && !TABLE_LABEL_PATTERN.test(normalized);
}

function looksLikeLabelledValue(value: string): boolean {
  const normalized = unquote(value);
  return normalized.length > 0 && !PLACEHOLDER_PATTERN.test(normalized) && !TABLE_LABEL_PATTERN.test(normalized);
}

function containsOnlyPlaceholderAssignments(input: string): boolean {
  const lines = input.split(/\r\n|[\r\n]/u).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return false;
  return lines.every((line) => {
    const assignment = INLINE_LABEL_PATTERN.exec(line);
    if (assignment === null) return false;
    const value = (assignment[3] ?? "").trim().replace(/^[`'"]|[`'"]$/gu, "");
    return PLACEHOLDER_PATTERN.test(value);
  });
}

function preserveIndent(original: string, replacement: string): string {
  return `${/^\s*/u.exec(original)?.[0] ?? ""}${replacement}`;
}

function redactCredentialTableRow(line: string, values: Set<string>): { kinds: PlaintextCredentialKind[]; text: string } | undefined {
  if (!line.includes("|")) return undefined;
  const cells = line.split("|");
  const kinds: PlaintextCredentialKind[] = [];
  for (let index = 0; index < cells.length - 1; index += 1) {
    const label = cells[index]?.trim() ?? "";
    const value = cells[index + 1]?.trim() ?? "";
    if (!TABLE_LABEL_PATTERN.test(label) || !looksLikeLabelledValue(value)) continue;
    values.add(unquote(value));
    cells[index + 1] = ` [REDACTED] `;
    kinds.push(kindForLabel(label));
  }
  return kinds.length ? { kinds, text: cells.join("|") } : undefined;
}

function unquote(value: string): string {
  return value.trim().replace(/^[`'"]|[`'"]$/gu, "");
}
