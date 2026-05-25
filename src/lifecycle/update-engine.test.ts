import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, writeFile, rm } from "node:fs/promises";
import {
  checkForUpdate,
  canApplyUpdate,
  prepareUpdateInfo,
  readCachedUpdateStatus,
  UPDATE_CACHE_TTL_MS
} from "./update-engine.js";

describe("checkForUpdate", () => {
  it("reports up-to-date when versions match", async () => {
    const mockFetch = () =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            tag_name: "v0.0.5",
            html_url: "https://example.com"
          })
      } as Response);

    const result = await checkForUpdate(mockFetch);
    expect(result.kind).toBe("up-to-date");
  });

  it("handles network errors gracefully", async () => {
    const mockFetch = () => Promise.reject(new Error("timeout"));
    const result = await checkForUpdate(mockFetch);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("timeout");
    }
  });

  it("treats cache write failures as non-fatal", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "estacoda-cache-write-test-"));
    const homeFile = join(tempDir, "home-file");
    await writeFile(homeFile, "not a directory");
    const mockFetch = () =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            tag_name: "v0.0.5",
            html_url: "https://example.com"
          })
      } as Response);

    const result = await checkForUpdate({ fetchFn: mockFetch, homeDir: homeFile });

    expect(result.kind).toBe("up-to-date");
  });
});

describe("canApplyUpdate", () => {
  it("rejects when ESTACODA_UPDATE_ARTIFACT is not set", () => {
    delete process.env.ESTACODA_UPDATE_ARTIFACT;
    const result = canApplyUpdate();
    expect(result.testable).toBe(false);
    expect(result.reason).toContain("not set");
  });

  it("rejects when artifact path does not exist", () => {
    process.env.ESTACODA_UPDATE_ARTIFACT = "/nonexistent/path/estacoda";
    const result = canApplyUpdate();
    expect(result.testable).toBe(false);
    expect(result.reason).toContain("does not exist");
  });

  it("accepts when artifact path exists", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "estacoda-update-test-"));
    const artifact = join(tempDir, "estacoda");
    writeFileSync(artifact, "binary", "utf8");

    process.env.ESTACODA_UPDATE_ARTIFACT = artifact;
    const result = canApplyUpdate();
    expect(result.testable).toBe(true);
  });
});

describe("prepareUpdateInfo", () => {
  it("includes current, latest, and protected paths", () => {
    const text = prepareUpdateInfo({
      current: "0.1.0",
      latest: "0.2.0",
      releaseNotesUrl: "https://example.com",
      breakingChanges: false
    });
    expect(text).toContain("0.1.0");
    expect(text).toContain("0.2.0");
    expect(text).toContain("Protected state paths");
  });

  it("warns about breaking changes", () => {
    const text = prepareUpdateInfo({
      current: "0.1.0",
      latest: "0.2.0",
      releaseNotesUrl: "https://example.com",
      breakingChanges: true
    });
    expect(text).toContain("breaking changes");
  });
});

describe("readCachedUpdateStatus", () => {
  it("returns unknown when cache file is missing", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "estacoda-cache-test-"));
    const result = await readCachedUpdateStatus(tempDir);
    expect(result).toBe("unknown");
  });

  it("returns cached up-to-date when cache is fresh", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "estacoda-cache-test-"));
    await mkdir(join(tempDir, ".estacoda"), { recursive: true });
    await writeFile(
      join(tempDir, ".estacoda", "update-cache.json"),
      JSON.stringify({ checkedAt: new Date().toISOString(), versionStatus: "up-to-date" })
    );
    const result = await readCachedUpdateStatus(tempDir);
    expect(result).toBe("up-to-date");
  });

  it("returns cached update-available when cache is fresh", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "estacoda-cache-test-"));
    await mkdir(join(tempDir, ".estacoda"), { recursive: true });
    await writeFile(
      join(tempDir, ".estacoda", "update-cache.json"),
      JSON.stringify({ checkedAt: new Date().toISOString(), versionStatus: "update-available" })
    );
    const result = await readCachedUpdateStatus(tempDir);
    expect(result).toBe("update-available");
  });

  it("uses a 6 hour cache TTL", () => {
    expect(UPDATE_CACHE_TTL_MS).toBe(6 * 60 * 60 * 1000);
  });

  it("returns cached status within the 6 hour cache TTL", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "estacoda-cache-test-"));
    await mkdir(join(tempDir, ".estacoda"), { recursive: true });
    const freshDate = new Date(Date.now() - UPDATE_CACHE_TTL_MS + 60 * 1000).toISOString();
    await writeFile(
      join(tempDir, ".estacoda", "update-cache.json"),
      JSON.stringify({ checkedAt: freshDate, versionStatus: "up-to-date" })
    );
    const result = await readCachedUpdateStatus(tempDir);
    expect(result).toBe("up-to-date");
  });

  it("returns unknown when cache is stale after the 6 hour cache TTL", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "estacoda-cache-test-"));
    await mkdir(join(tempDir, ".estacoda"), { recursive: true });
    const oldDate = new Date(Date.now() - UPDATE_CACHE_TTL_MS - 60 * 1000).toISOString();
    await writeFile(
      join(tempDir, ".estacoda", "update-cache.json"),
      JSON.stringify({ checkedAt: oldDate, versionStatus: "up-to-date" })
    );
    const result = await readCachedUpdateStatus(tempDir);
    expect(result).toBe("unknown");
  });

  it("returns unknown when cache contains invalid JSON", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "estacoda-cache-test-"));
    await mkdir(join(tempDir, ".estacoda"), { recursive: true });
    await writeFile(join(tempDir, ".estacoda", "update-cache.json"), "not json");
    const result = await readCachedUpdateStatus(tempDir);
    expect(result).toBe("unknown");
  });

  it("treats cache read failures as non-fatal", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "estacoda-cache-test-"));
    await writeFile(join(tempDir, ".estacoda"), "not a directory");

    const result = await readCachedUpdateStatus(tempDir);

    expect(result).toBe("unknown");
  });

  it("returns unknown when cache has invalid versionStatus", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "estacoda-cache-test-"));
    await mkdir(join(tempDir, ".estacoda"), { recursive: true });
    await writeFile(
      join(tempDir, ".estacoda", "update-cache.json"),
      JSON.stringify({ checkedAt: new Date().toISOString(), versionStatus: "bogus" })
    );
    const result = await readCachedUpdateStatus(tempDir);
    expect(result).toBe("unknown");
  });
});
