import { isAlwaysBlockedUrl, parseHttpUrl, scanUrlForSecrets } from "./url-safety.js";
import { redactSensitiveText } from "../utils/redaction.js";

/** Retain exact, non-secret locators, never a rewritten approximation. Navigation
 * still runs the current DNS, private-network and website policy checks. */
export function browserContinuityUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 500 || value.trim() !== value) return undefined;
  const url = parseHttpUrl(value);
  if (url === undefined || url.username || url.password || isAlwaysBlockedUrl(value)) return undefined;
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { return undefined; }
  if (scanUrlForSecrets(decoded) !== undefined || redactSensitiveText(decoded) !== decoded ||
    /[\u0000-\u001f\u007f]/u.test(decoded) ||
    /(?:[?&#;]|^)(?:[^=&#;]*(?:token|secret|password|credential|authorization|signature|session|csrf|api.?key|code)[^=&#;]*)=/iu.test(decoded)) {
    return undefined;
  }
  return url.toString();
}
