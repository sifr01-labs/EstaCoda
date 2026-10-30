import type { ProviderErrorDiagnostics } from "../contracts/provider.js";
import { redactSensitiveText } from "../utils/redaction.js";

/** Allowlisted transport metadata only. Never retain messages, bodies or headers. */
export function providerErrorDiagnostics(value: unknown): ProviderErrorDiagnostics | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const result: ProviderErrorDiagnostics = {};
  for (const key of ["code", "type"] as const) {
    const item = record[key];
    if (typeof item === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(item) &&
        !/^(?:sk_|token_|secret_|password_)/u.test(item) && redactSensitiveText(item) === item) result[key] = item;
  }
  if (typeof record.httpStatus === "number" && Number.isInteger(record.httpStatus) &&
      record.httpStatus >= 100 && record.httpStatus <= 599) result.httpStatus = record.httpStatus;
  if (typeof record.requestId === "string" && /^req_[a-zA-Z0-9_-]{1,100}$/u.test(record.requestId) &&
      redactSensitiveText(record.requestId) === record.requestId) result.requestId = record.requestId;
  return Object.keys(result).length === 0 ? undefined : result;
}
