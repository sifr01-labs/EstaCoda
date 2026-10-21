export type RedactionOptions = {
  /** Additional key names (case-insensitive) to redact beyond defaults. */
  additionalKeys?: string[];
  /** When true, also redact values that look like API keys/tokens even if key is unknown. */
  strict?: boolean;
};

const REDACTED = "[REDACTED]";

const DEFAULT_SENSITIVE_KEYS = new Set([
  "apikey",
  "api_key",
  "api-key",
  "token",
  "secret",
  "password",
  "passwd",
  "auth",
  "authorization",
  "credential",
  "credentials",
  "access_token",
  "accessToken",
  "refresh_token",
  "refreshToken",
  "bearer",
  "private_key",
  "privateKey",
  "keyid",
  "key_id",
  "client_secret",
  "clientSecret",
  "bot_token",
  "botToken",
  "session_token",
  "sessionToken",
  "cookie",
  "csrf",
  "xsrf",
  "mfa_secret",
  "mfaSecret",
  "backup_codes",
  "backupCodes"
]);

const HIGH_ENTROPY_PATTERN = /^(?:[a-zA-Z0-9+/=_-]{32,}|eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*)$/;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/giu;
const BASIC_AUTH_PATTERN = /\bBasic\s+[A-Za-z0-9._~+/=-]{16,}/giu;
const URL_CREDENTIAL_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/giu;
// Quoted values may contain spaces, escaped quotes and line breaks. An
// unterminated quote withholds the remaining text rather than leaking a suffix.
export const QUOTED_CREDENTIAL_VALUE_PATTERN = String.raw`(?:"(?:\\[\s\S]|\\$|[^"\\])*(?:"|$)|'(?:\\[\s\S]|\\$|[^'\\])*(?:'|$)|\x60(?:\\[\s\S]|\\$|[^\x60\\])*(?:\x60|$))`;
const SECRET_VALUE = String.raw`(?:${QUOTED_CREDENTIAL_VALUE_PATTERN}|[^\s"'\x60]+)`;
const ENV_SECRET_PATTERN = new RegExp(String.raw`\b([A-Z][A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASS|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)[A-Z0-9_]*\s*=\s*)(${SECRET_VALUE})`, "gu");
const PASSWORD_ASSIGNMENT_PATTERN = new RegExp(String.raw`(["']?\b(?:password|passwd|pwd|secret|token|api[_-]?key)(?:["']?)\s*[:=]\s*)(${SECRET_VALUE})`, "giu");
const TOOL_SECRET_PATTERN = new RegExp(String.raw`(["']?\b(?:x-api-key|api-key|access_token|refresh_token|client_secret)(?:["']?)\s*[:=]\s*)(${SECRET_VALUE})`, "giu");
const PRIVATE_KEY_PATTERN = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/gu;
const COMMON_API_KEY_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]*api[_-]?key[A-Za-z0-9_-]*[=:][A-Za-z0-9_-]{16,})/giu;

function isSensitiveKey(key: string, options?: RedactionOptions): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, "");
  const allKeys = new Set([...DEFAULT_SENSITIVE_KEYS, ...(options?.additionalKeys ?? [])]);

  for (const candidate of allKeys) {
    if (normalized === candidate.toLowerCase().replace(/[-_]/g, "")) {
      return true;
    }
  }

  return false;
}

function looksLikeSecret(value: string, options?: RedactionOptions): boolean {
  if (options?.strict !== true) return false;
  if (value.length < 24) return false;
  return HIGH_ENTROPY_PATTERN.test(value);
}

export function redactSensitiveText(input: string): string {
  const values = new Set<string>();
  const mask = (value: string): string => {
    if (value && value !== REDACTED && !/^%5BREDACTED%5D$/iu.test(value)) values.add(value);
    return REDACTED;
  };
  const assignment = (_match: string, prefix: string, value: string): string => {
    const quote = /^["'`]/u.test(value) ? value[0]! : undefined;
    const raw = quote === undefined ? value : value.slice(1, value.endsWith(quote) ? -1 : undefined);
    // JSON-style escaped forms and literal repeats must both be withheld.
    if (quote === '"') {
      try { values.add(JSON.parse(value) as string); }
      catch { /* Incomplete values remain masked. */ }
    }
    return `${prefix}${quote ?? ""}${mask(raw)}${quote ?? ""}`;
  };
  const redacted = input
    .replace(PRIVATE_KEY_PATTERN, value => mask(value))
    .replace(URL_CREDENTIAL_PATTERN, (_match, protocol: string, user: string, password: string) => `${protocol}${mask(user)}:${mask(password)}@`)
    .replace(BEARER_PATTERN, value => `Bearer ${mask(value.replace(/^Bearer\s+/iu, ""))}`)
    .replace(BASIC_AUTH_PATTERN, value => `Basic ${mask(value.replace(/^Basic\s+/iu, ""))}`)
    .replace(JWT_PATTERN, value => mask(value))
    .replace(ENV_SECRET_PATTERN, assignment)
    .replace(PASSWORD_ASSIGNMENT_PATTERN, assignment)
    .replace(TOOL_SECRET_PATTERN, assignment)
    .replace(COMMON_API_KEY_PATTERN, value => mask(value));
  return redactKnownCredentialValues(redacted, values);
}

/** Ephemeral, exact-value scrubbing within one message; no credential registry
 * or persistence. Short values match token boundaries to avoid erasing prose. */
export function redactKnownCredentialValues(input: string, values: ReadonlySet<string>): string {
  // Unusually dense submissions fail closed without quadratic repeated scans.
  if (values.size > 128) return REDACTED;
  let result = input;
  for (const value of [...values].filter(value => value && value !== REDACTED).sort((left, right) => right.length - left.length)) {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const pattern = value.length < 8 ? `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])` : escaped;
    const matcher = new RegExp(pattern, "gu");
    result = result.split(REDACTED).map(part => part.replace(matcher, () => REDACTED)).join(REDACTED);
  }
  return result;
}

export function redactValue(key: string, value: unknown, options?: RedactionOptions): unknown {
  if (typeof value === "string") {
    if (isSensitiveKey(key, options) || looksLikeSecret(value, options)) {
      return REDACTED;
    }
    return redactSensitiveText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => redactValue(`${key}[${index}]`, item, options));
  }

  if (value !== null && typeof value === "object") {
    return redactObject(value, options);
  }

  return value;
}

export function redactObject(obj: unknown, options?: RedactionOptions): unknown {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item, index) => redactValue(`[${index}]`, item, options));
  }

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    result[key] = redactValue(key, value, options);
  }

  return result;
}

export function redactJson(json: string, options?: RedactionOptions): string {
  try {
    const parsed = JSON.parse(json);
    return JSON.stringify(redactObject(parsed, options), null, 2);
  } catch {
    return redactString(json, options);
  }
}

export function redactString(input: string, options?: RedactionOptions): string {
  let result = redactSensitiveText(input);

  for (const key of DEFAULT_SENSITIVE_KEYS) {
    const pattern = new RegExp(`(["']?${key}["']?\\s*[:=]\\s*["']?)([^"'\\s&;]+)`, "gi");
    result = result.replace(pattern, `$1${REDACTED}`);
  }

  for (const key of options?.additionalKeys ?? []) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(["']?${escaped}["']?\\s*[:=]\\s*["']?)([^"'\\s&;]+)`, "gi");
    result = result.replace(pattern, `$1${REDACTED}`);
  }

  return result;
}
