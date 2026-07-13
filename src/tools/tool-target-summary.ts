const MAX_SECURITY_SUMMARY_CHARS = 120;
const MAX_DISPLAY_PREVIEW_CHARS = 96;
const REDACTED_DISPLAY_VALUE = "[redacted]";

const SENSITIVE_QUERY_PARAM_VALUE_RE = /(^|[?&;\s])((?:token|access_token|refresh_token|id_token|api_key|key|password|passwd|secret|client_secret|auth|authorization)=)([^&;\s]+)/giu;
const SENSITIVE_FIELD_VALUE_RE = /(^|["'{,\s])((?:apiKey|api[_-]?key|key|token|access_token|refresh_token|id_token|password|passwd|secret|client_secret|credential|auth|authorization)["']?\s*[:=]\s*["']?)(?!(?:bearer|basic)\b)([^"',\s}]+)/giu;
const AUTH_VALUE_RE = /\b((?:authorization\s*:\s*)?(?:bearer|basic)\s+)([\w.\-~+/]+=*)/giu;
const TOKEN_PREFIX_RE = /\b(?:sk-ant-|sk-proj-|sk-|ghp_|github_pat_)[A-Za-z0-9_\-]+/gu;

export function buildToolSecurityTargetSummary(toolName: string, input: Record<string, unknown>): string | undefined {
  if ((toolName === "terminal.run" || toolName === "process.start") && typeof input.command === "string") {
    return truncateSecuritySummary(input.command);
  }

  if (toolName === "terminal.inspect") {
    return terminalInspectArgvPreview(input.argv, { securitySummary: true });
  }

  for (const key of ["path", "url", "file_path", "pattern", "query", "prompt", "goal"] as const) {
    const summary = summarizeInputString(input[key]);
    if (summary !== undefined) {
      return summary;
    }
  }

  for (const key of ["content", "text", "code", "script"] as const) {
    const summary = summarizeInputString(input[key], { firstLineOnly: true });
    if (summary !== undefined) {
      return summary;
    }
  }

  return undefined;
}

export function buildToolDisplayPreview(toolName: string, input: Record<string, unknown>): string | undefined {
  if ((toolName === "terminal.run" || toolName === "process.start") && typeof input.command === "string") {
    return compactCommandPreview(input.command);
  }

  if (toolName === "terminal.inspect") {
    return terminalInspectArgvPreview(input.argv);
  }

  if (toolName === "file.read") {
    return displayPreviewWithLineRange(input.path, input.lineStart, input.lineEnd);
  }

  if (toolName === "file.write" || toolName === "file.patch" || toolName === "notebook.edit") {
    return redactToolDisplayPreview(input.path);
  }

  if (toolName === "browser.type") {
    return redactToolDisplayPreview(input.text);
  }

  if (toolName === "browser.click") {
    return redactToolDisplayPreview(input.ref);
  }

  if (toolName === "browser.press") {
    return redactToolDisplayPreview(input.key);
  }

  if (toolName === "browser.scroll") {
    return displayScrollPreview(input.direction, input.amount);
  }

  if (toolName === "delegate_task") {
    return displayDelegateTaskPreview(input);
  }

  const summary = buildToolSecurityTargetSummary(toolName, input);
  return summary === undefined ? undefined : truncateDisplayPreview(redactSecretsInString(summary));
}

export function redactToolDisplayPreview(value: unknown): string | undefined {
  const summary = summarizeInputString(value, { firstLineOnly: true });
  if (summary === undefined) {
    return undefined;
  }
  return truncateDisplayPreview(redactSecretsInString(summary));
}

function displayPreviewWithLineRange(path: unknown, lineStart: unknown, lineEnd: unknown): string | undefined {
  const pathPreview = redactToolDisplayPreview(path);
  if (pathPreview === undefined) {
    return undefined;
  }

  const start = positiveInteger(lineStart);
  const end = positiveInteger(lineEnd);
  if (start === undefined && end === undefined) {
    return pathPreview;
  }
  if (start !== undefined && end !== undefined && end !== start) {
    return truncateDisplayPreview(`${pathPreview} L${start}-${end}`);
  }
  return truncateDisplayPreview(`${pathPreview} L${start ?? end}`);
}

function displayScrollPreview(direction: unknown, amount: unknown): string | undefined {
  const directionPreview = redactToolDisplayPreview(direction);
  const amountPreview = typeof amount === "number" && Number.isFinite(amount) ? String(amount) : undefined;
  if (directionPreview === undefined) {
    return amountPreview;
  }
  if (amountPreview === undefined) {
    return directionPreview;
  }
  return truncateDisplayPreview(`${directionPreview} ${amountPreview}`);
}

function displayDelegateTaskPreview(input: Record<string, unknown>): string | undefined {
  const singleTask = redactToolDisplayPreview(input.task);
  if (singleTask !== undefined) {
    return singleTask;
  }

  if (Array.isArray(input.tasks)) {
    const first = input.tasks.find((entry) => isObjectRecord(entry) && typeof entry.task === "string");
    const firstTask = isObjectRecord(first) ? redactToolDisplayPreview(first.task) : undefined;
    if (firstTask === undefined) {
      return `${input.tasks.length} tasks`;
    }
    if (input.tasks.length <= 1) {
      return firstTask;
    }
    return truncateDisplayPreview(`${firstTask} + ${input.tasks.length - 1} tasks`);
  }

  return redactToolDisplayPreview(input.tasks);
}

function compactCommandPreview(command: string): string | undefined {
  const segments = command
    .split(/\s*(?:&&|\|\||;)\s*/u)
    .map(normalizeWhitespace)
    .filter((segment) => segment.length > 0);
  const selected = segments.filter((segment) => !isCommandBoundaryNoise(segment));
  const displaySegments = selected.length > 0 ? selected : segments;
  const head = displaySegments[0];
  if (head === undefined) {
    return undefined;
  }

  const pipeCompacted = compactPipes(head);
  const suffix = displaySegments.length > 1 ? ` + ${displaySegments.length - 1} cmds` : "";
  return truncateDisplayPreview(`${redactSecretsInString(pipeCompacted)}${suffix}`);
}

function terminalInspectArgvPreview(
  value: unknown,
  options: { readonly securitySummary?: boolean } = {}
): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (!value.every((entry): entry is string => typeof entry === "string")) return undefined;
  const parts = value.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (parts.length === 0) return undefined;
  const rendered = parts.map(formatArgvPartForDisplay).join(" ");
  const redacted = redactSecretsInString(rendered);
  return options.securitySummary === true
    ? truncateSecuritySummary(redacted)
    : truncateDisplayPreview(redacted);
}

function formatArgvPartForDisplay(value: string): string {
  if (!/\s/u.test(value)) return value;
  const escaped = value.replace(/\\/gu, "\\\\").replace(/"/gu, "\\\"");
  return `"${escaped}"`;
}

function compactPipes(command: string): string {
  const pipeIndex = command.indexOf(" | ");
  return pipeIndex === -1 ? command : `${command.slice(0, pipeIndex).trim()} | ...`;
}

function isCommandBoundaryNoise(command: string): boolean {
  return /^(?:cd|pwd|true|echo|export)(?:\s|$)/u.test(command);
}

function summarizeInputString(value: unknown, options?: { firstLineOnly?: boolean }): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const selected = options?.firstLineOnly === true ? value.split(/\r?\n/u)[0] ?? "" : value;
  const trimmed = selected.trim();
  return trimmed.length === 0 ? undefined : truncateSecuritySummary(trimmed);
}

function truncateSecuritySummary(value: string): string {
  const trimmed = normalizeWhitespace(value);
  return trimmed.length <= MAX_SECURITY_SUMMARY_CHARS
    ? trimmed
    : `${trimmed.slice(0, MAX_SECURITY_SUMMARY_CHARS - 3)}...`;
}

function truncateDisplayPreview(value: string): string {
  const trimmed = normalizeWhitespace(value);
  return trimmed.length <= MAX_DISPLAY_PREVIEW_CHARS
    ? trimmed
    : `${trimmed.slice(0, MAX_DISPLAY_PREVIEW_CHARS - 3)}...`;
}

function redactSecretsInString(value: string): string {
  if (containsUrlUserInfoCredentials(value)) {
    return REDACTED_DISPLAY_VALUE;
  }
  return value
    .replace(SENSITIVE_QUERY_PARAM_VALUE_RE, (_match, prefix: string, key: string) => `${prefix}${key}${REDACTED_DISPLAY_VALUE}`)
    .replace(AUTH_VALUE_RE, (_match, prefix: string) => `${prefix}${REDACTED_DISPLAY_VALUE}`)
    .replace(SENSITIVE_FIELD_VALUE_RE, (_match, prefix: string, key: string) => `${prefix}${key}${REDACTED_DISPLAY_VALUE}`)
    .replace(TOKEN_PREFIX_RE, REDACTED_DISPLAY_VALUE);
}

function containsUrlUserInfoCredentials(value: string): boolean {
  const urls = value.match(/https?:\/\/[^\s"'<>\\)]+/giu) ?? [];
  for (const rawUrl of urls) {
    try {
      const url = new URL(rawUrl);
      if (url.username.length > 0 || url.password.length > 0) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
