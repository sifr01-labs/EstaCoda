import { redactSensitiveText } from "../utils/redaction.js";

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
  const baseline = redactSensitiveText(input);
  if (baseline !== input && !containsOnlyPlaceholderAssignments(input)) {
    detected = true;
    collectKindsFromText(input, kinds);
  }

  const originalLines = input.split(/\r?\n/u);
  const redactedLines = baseline.split(/\r?\n/u);
  for (let index = 0; index < originalLines.length; index += 1) {
    const originalLine = originalLines[index] ?? "";
    const inline = INLINE_LABEL_PATTERN.exec(originalLine);
    if (inline !== null && looksLikeSubmittedValue(inline[3] ?? "")) {
      detected = true;
      kinds.add(kindForLabel(inline[2] ?? ""));
      redactedLines[index] = `${inline[1]}[REDACTED]`;
      continue;
    }

    const label = LABEL_ONLY_PATTERN.exec(originalLine);
    if (label !== null) {
      const valueIndex = nextNonEmptyLine(originalLines, index + 1);
      if (valueIndex !== undefined && looksLikeSubmittedValue(originalLines[valueIndex] ?? "")) {
        detected = true;
        kinds.add(kindForLabel(label[1] ?? ""));
        redactedLines[valueIndex] = preserveIndent(originalLines[valueIndex] ?? "", "[REDACTED]");
      }
    }

    const table = redactCredentialTableRow(originalLine);
    if (table !== undefined) {
      detected = true;
      kinds.add(table.kind);
      redactedLines[index] = table.text;
    }
  }

  if (detected && kinds.size === 0) kinds.add("generic-secret");
  return {
    detected,
    kinds: [...kinds],
    redactedText: redactedLines.join("\n")
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
      `The user attempted to submit plaintext credentials (${labels}).`,
      "EstaCoda withheld the values before session persistence and provider dispatch.",
      "Continue the active task and request each value through the configured protected-input tool argument flow; do not ask for or repeat credentials in ordinary chat."
    ].join(" ")
  };
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
  const normalized = value.trim().replace(/^[`'"]|[`'"]$/gu, "");
  if (normalized.length < 8 || normalized.length > 4_096) return false;
  if (PLACEHOLDER_PATTERN.test(normalized)) return false;
  return !/\s/u.test(normalized) && !TABLE_LABEL_PATTERN.test(normalized);
}

function containsOnlyPlaceholderAssignments(input: string): boolean {
  const lines = input.split(/\r?\n/u).filter((line) => line.trim().length > 0);
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

function redactCredentialTableRow(line: string): { kind: PlaintextCredentialKind; text: string } | undefined {
  if (!line.includes("|")) return undefined;
  const cells = line.split("|");
  for (let index = 0; index < cells.length - 1; index += 1) {
    const label = cells[index]?.trim() ?? "";
    const value = cells[index + 1]?.trim() ?? "";
    if (!TABLE_LABEL_PATTERN.test(label) || !looksLikeSubmittedValue(value)) continue;
    cells[index + 1] = ` [REDACTED] `;
    return { kind: kindForLabel(label), text: cells.join("|") };
  }
  return undefined;
}
