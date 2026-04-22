import { extname, relative } from "node:path";

const SENSITIVE_SEGMENTS = new Set([
  ".env",
  ".ssh",
  ".gnupg",
  ".aws",
  ".config/gcloud",
  "keychain",
  "secrets",
  "tokens"
]);

const SENSITIVE_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".crt"]);
const TEXTY_EXTENSIONS = new Set([
  "",
  ".cjs",
  ".css",
  ".csv",
  ".env.example",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mdc",
  ".mjs",
  ".py",
  ".rs",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml"
]);

export function explainPathBlock(root: string, target: string): string | undefined {
  const relativePath = relative(root, target);

  if (relativePath === "") {
    return undefined;
  }

  if (relativePath.startsWith("..") || relativePath.startsWith("/")) {
    return "path is outside the trusted workspace";
  }

  const normalized = relativePath.split("\\").join("/");
  const segments = normalized.split("/");

  for (const sensitive of SENSITIVE_SEGMENTS) {
    if (normalized === sensitive || normalized.startsWith(`${sensitive}/`) || segments.includes(sensitive)) {
      return `path matches sensitive area ${sensitive}`;
    }
  }

  const extension = extname(target).toLowerCase();
  if (SENSITIVE_EXTENSIONS.has(extension)) {
    return `file extension ${extension} is treated as sensitive`;
  }

  return undefined;
}

export function isLikelyBinary(buffer: Buffer): boolean {
  if (buffer.includes(0)) {
    return true;
  }

  const extensionSample = buffer.subarray(0, Math.min(buffer.length, 512));
  let suspicious = 0;

  for (const byte of extensionSample) {
    if (byte < 7 || (byte > 14 && byte < 32)) {
      suspicious++;
    }
  }

  return suspicious > extensionSample.length * 0.15;
}

export function isTextyPath(path: string): boolean {
  const extension = extname(path).toLowerCase();
  return TEXTY_EXTENSIONS.has(extension);
}

export function hasPromptInjectionRisk(content: string): boolean {
  return /ignore (all )?(previous|prior) instructions/i.test(content) ||
    /reveal (the )?(system|developer) prompt/i.test(content) ||
    /exfiltrat(e|ion)|steal (secrets|tokens|keys)/i.test(content);
}
