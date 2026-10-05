import { describe, expect, it } from "vitest";
import {
  assessUrlSafety,
  isAlwaysBlockedNetwork,
  isSafeUrl,
  redactUrlForMetadata,
  scanUrlForSecrets,
  type ResolveHostnameFn
} from "./url-safety.js";

const publicResolver: ResolveHostnameFn = async () => ["93.184.216.34"];

describe("url safety", () => {
  it("distinguishes failed DNS from unsafe destinations without allowing either", async () => {
    const options = { resolveHostname: async () => { throw new Error("DNS unavailable"); } };
    expect(await assessUrlSafety("https://missing.example/", options)).toBe("unresolved");
    expect(await isSafeUrl("https://missing.example/", options)).toBe(false);
    expect(await assessUrlSafety("https://missing.example/", { resolveHostname: async () => [] })).toBe("unresolved");
    expect(await assessUrlSafety("http://127.0.0.1", options)).toBe("unsafe");
    expect(await assessUrlSafety("https://metadata.google.internal", options)).toBe("unsafe");
  });
  it("accepts public HTTP and HTTPS URLs", async () => {
    await expect(isSafeUrl("http://example.com", { resolveHostname: publicResolver })).resolves.toBe(true);
    await expect(isSafeUrl("https://example.com", { resolveHostname: publicResolver })).resolves.toBe(true);
  });

  it("rejects non-HTTP schemes", async () => {
    await expect(isSafeUrl("file:///etc/passwd", { resolveHostname: publicResolver })).resolves.toBe(false);
  });

  it("rejects localhost and private literal IPv4 addresses by default", async () => {
    await expect(isSafeUrl("http://localhost", { resolveHostname: async () => ["127.0.0.1"] })).resolves.toBe(false);
    await expect(isSafeUrl("http://127.0.0.1")).resolves.toBe(false);
    await expect(isSafeUrl("http://192.168.1.1")).resolves.toBe(false);
  });

  it("rejects CGNAT addresses by default", async () => {
    await expect(isSafeUrl("http://100.64.0.1")).resolves.toBe(false);
  });

  it("rejects IPv6 loopback by default", async () => {
    await expect(isSafeUrl("http://[::1]")).resolves.toBe(false);
  });

  it("rejects metadata IPs and metadata hostnames", async () => {
    await expect(isSafeUrl("http://169.254.169.254")).resolves.toBe(false);
    await expect(isSafeUrl("http://metadata.google.internal", { resolveHostname: publicResolver })).resolves.toBe(false);
    expect(isAlwaysBlockedNetwork("169.254.170.2")).toBe(true);
  });

  it("rejects DNS failure and thrown mock resolvers", async () => {
    await expect(isSafeUrl("https://example.com", { resolveHostname: async () => [] })).resolves.toBe(false);
    await expect(isSafeUrl("https://example.com", {
      resolveHostname: async () => {
        throw new Error("dns failed");
      }
    })).resolves.toBe(false);
  });

  it("rejects hostnames resolving to private IPs and accepts public IPs", async () => {
    await expect(isSafeUrl("https://example.com", { resolveHostname: async () => ["10.0.0.5"] })).resolves.toBe(false);
    await expect(isSafeUrl("https://example.com", { resolveHostname: async () => ["93.184.216.34"] })).resolves.toBe(true);
  });

  it("allows ordinary private URLs when configured but keeps metadata blocked", async () => {
    await expect(isSafeUrl("http://192.168.1.1", { allowPrivateUrls: true })).resolves.toBe(true);
    await expect(isSafeUrl("http://169.254.169.254", { allowPrivateUrls: true })).resolves.toBe(false);
  });

  it("handles IPv4-mapped IPv6 metadata and private addresses", async () => {
    await expect(isSafeUrl("http://[::ffff:169.254.169.254]", { allowPrivateUrls: true })).resolves.toBe(false);
    await expect(isSafeUrl("http://[::ffff:192.168.1.1]")).resolves.toBe(false);
    await expect(isSafeUrl("http://[::ffff:c0a8:0101]")).resolves.toBe(false);
  });

  it("detects raw and encoded secret markers without crashing malformed encodings", () => {
    expect(scanUrlForSecrets("https://example.com/?token=secret")).toBe("token=");
    expect(scanUrlForSecrets("https://example.com/?q=Bearer%20secret")).toBe("Bearer ");
    expect(scanUrlForSecrets("https://example.com/%E0%A4%A")).toBeUndefined();
  });

  it("redacts secret-bearing URLs from metadata", () => {
    expect(redactUrlForMetadata("https://example.com/?api_key=secret")).toBe("[REDACTED_URL_WITH_SECRET]");
    expect(redactUrlForMetadata("not a url with sk-secret")).toBe("[REDACTED_URL_WITH_SECRET]");
    expect(redactUrlForMetadata("notaurl")).toBe("[INVALID_URL]");
  });
});
