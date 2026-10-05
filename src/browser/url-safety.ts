import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type ResolveHostnameFn = (hostname: string) => Promise<string[]> | string[];

export type UrlSafetyOptions = {
  allowPrivateUrls?: boolean;
  resolveHostname?: ResolveHostnameFn;
};

export const ALWAYS_BLOCKED_HOSTNAMES = [
  "metadata.google.internal",
  "metadata.goog"
] as const;

export const ALWAYS_BLOCKED_IPS = [
  "169.254.169.254",
  "169.254.170.2",
  "169.254.169.253",
  "fd00:ec2::254",
  "100.100.100.200"
] as const;

export const CGNAT_CIDR = "100.64.0.0/10";

const SECRET_MARKERS = [
  "sk-",
  "sk-ant-",
  "sk-proj-",
  "ghp_",
  "gho_",
  "github_pat_",
  "Bearer ",
  "Basic ",
  "ApiKey ",
  "api_key=",
  "token=",
  "key="
] as const;

export function isAlwaysBlockedNetwork(ip: string): boolean {
  const normalized = normalizeIpForChecks(ip);
  if (normalized === undefined) {
    return false;
  }
  return ALWAYS_BLOCKED_IPS.includes(normalized as (typeof ALWAYS_BLOCKED_IPS)[number]);
}

export async function isSafeUrl(url: string, options: UrlSafetyOptions = {}): Promise<boolean> {
  return await assessUrlSafety(url, options) === "safe";
}

/** Unresolved hosts remain unfetchable, but are not proven private addresses. */
export async function assessUrlSafety(url: string, options: UrlSafetyOptions = {}): Promise<"safe" | "unsafe" | "unresolved"> {
  const parsed = parseHttpUrl(url);
  if (parsed === undefined) {
    return "unsafe";
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (isAlwaysBlockedHostname(hostname)) {
    return "unsafe";
  }

  const literalIp = normalizeIpForChecks(hostname);
  if (literalIp !== undefined) {
    if (isAlwaysBlockedNetwork(literalIp)) {
      return "unsafe";
    }
    return options.allowPrivateUrls === true || !isPrivateOrInternalIp(literalIp) ? "safe" : "unsafe";
  }

  let addresses: string[];
  try {
    addresses = await resolveHostname(hostname, options.resolveHostname);
  } catch {
    return "unresolved";
  }

  if (addresses.length === 0) {
    return "unresolved";
  }

  return addresses.every((address) => {
    const normalizedIp = normalizeIpForChecks(address);
    if (normalizedIp === undefined) {
      return false;
    }
    if (isAlwaysBlockedNetwork(normalizedIp)) {
      return false;
    }
    return options.allowPrivateUrls === true || !isPrivateOrInternalIp(normalizedIp);
  }) ? "safe" : "unsafe";
}

export function isAlwaysBlockedUrl(url: string): boolean {
  const parsed = parseHttpUrl(url);
  if (parsed === undefined) {
    return true;
  }
  const hostname = normalizeHostname(parsed.hostname);
  if (isAlwaysBlockedHostname(hostname)) {
    return true;
  }
  const literalIp = normalizeIpForChecks(hostname);
  return literalIp !== undefined && isAlwaysBlockedNetwork(literalIp);
}

export function scanUrlForSecrets(url: string): string | undefined {
  const candidates = [url];
  const decoded = safeDecodeURIComponent(url);
  if (decoded !== undefined && decoded !== url) {
    candidates.push(decoded);
  }

  for (const candidate of candidates) {
    for (const marker of SECRET_MARKERS) {
      if (candidate.includes(marker)) {
        return marker;
      }
    }
  }
  return undefined;
}

export function redactUrlForMetadata(url: string): string {
  if (scanUrlForSecrets(url) !== undefined) {
    return "[REDACTED_URL_WITH_SECRET]";
  }

  try {
    const parsed = new URL(url);
    if (parsed.username.length > 0) parsed.username = "[REDACTED]";
    if (parsed.password.length > 0) parsed.password = "[REDACTED]";
    return parsed.toString();
  } catch {
    return "[INVALID_URL]";
  }
}

export function parseHttpUrl(value: string): URL | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function isAlwaysBlockedHostname(hostname: string): boolean {
  return ALWAYS_BLOCKED_HOSTNAMES.includes(hostname as (typeof ALWAYS_BLOCKED_HOSTNAMES)[number]);
}

export async function resolveHostname(hostname: string, resolver: ResolveHostnameFn | undefined): Promise<string[]> {
  if (resolver !== undefined) {
    return await resolver(hostname);
  }

  const resolved = await lookup(hostname, {
    all: true,
    verbatim: true
  });
  return resolved.map((entry) => entry.address);
}

export function normalizeHostname(hostname: string): string {
  return stripIpv6Brackets(hostname).trim().toLowerCase().replace(/\.+$/, "");
}

function stripIpv6Brackets(value: string): string {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

export function normalizeIpForChecks(value: string): string | undefined {
  const trimmed = stripIpv6Brackets(value.trim()).toLowerCase();
  if (isIP(trimmed) === 0) {
    return undefined;
  }
  return normalizeIpv4Mapped(trimmed);
}

function normalizeIpv4Mapped(ip: string): string {
  if (!ip.startsWith("::ffff:")) {
    return ip;
  }

  const suffix = ip.slice("::ffff:".length);
  if (isIP(suffix) === 4) {
    return suffix;
  }

  const hextets = suffix.split(":");
  if (hextets.length !== 2) {
    return ip;
  }

  const high = Number.parseInt(hextets[0], 16);
  const low = Number.parseInt(hextets[1], 16);
  if (!Number.isInteger(high) || !Number.isInteger(low) || high < 0 || high > 0xffff || low < 0 || low > 0xffff) {
    return ip;
  }

  return [
    (high >> 8) & 0xff,
    high & 0xff,
    (low >> 8) & 0xff,
    low & 0xff
  ].join(".");
}

export function isPrivateOrInternalIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    return isPrivateOrInternalIpv4(ip);
  }
  return isPrivateOrInternalIpv6(ip);
}

function isPrivateOrInternalIpv4(ip: string): boolean {
  const value = ipv4ToNumber(ip);
  if (value === undefined) {
    return true;
  }

  return [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4]
  ].some(([network, prefix]) => ipv4InCidr(value, network as string, prefix as number));
}

function ipv4ToNumber(ip: string): number | undefined {
  const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return undefined;
  }
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function ipv4InCidr(value: number, network: string, prefix: number): boolean {
  const networkValue = ipv4ToNumber(network);
  if (networkValue === undefined) {
    return false;
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (networkValue & mask);
}

function isPrivateOrInternalIpv6(ip: string): boolean {
  const hextets = expandIpv6(ip);
  if (hextets === undefined) {
    return true;
  }

  const first = hextets[0];
  const second = hextets[1];
  const allZero = hextets.every((hextet) => hextet === 0);
  const loopback = hextets.slice(0, 7).every((hextet) => hextet === 0) && hextets[7] === 1;

  return allZero ||
    loopback ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xff00) === 0xff00 ||
    (first === 0x2001 && second === 0x0db8);
}

function expandIpv6(ip: string): number[] | undefined {
  if (isIP(ip) !== 6) {
    return undefined;
  }

  const normalized = ip.toLowerCase();
  const [leftPart, rightPart] = normalized.split("::");
  if (normalized.split("::").length > 2) {
    return undefined;
  }

  const left = parseIpv6Hextets(leftPart);
  const right = rightPart === undefined ? [] : parseIpv6Hextets(rightPart);
  if (left === undefined || right === undefined) {
    return undefined;
  }

  if (rightPart === undefined) {
    return left.length === 8 ? left : undefined;
  }

  const zeroCount = 8 - left.length - right.length;
  if (zeroCount < 1) {
    return undefined;
  }
  return [...left, ...Array.from({ length: zeroCount }, () => 0), ...right];
}

function parseIpv6Hextets(value: string): number[] | undefined {
  if (value.length === 0) {
    return [];
  }
  const parts = value.split(":");
  const hextets: number[] = [];
  for (const part of parts) {
    if (part.length === 0 || part.length > 4) {
      return undefined;
    }
    const parsed = Number.parseInt(part, 16);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffff) {
      return undefined;
    }
    hextets.push(parsed);
  }
  return hextets;
}

function safeDecodeURIComponent(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
