import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PersistentCliSessionStore } from "./cli-session-store.js";
import { resolveStartupSessionId } from "../session/session-id.js";

describe("PersistentCliSessionStore", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "estacoda-cli-session-store-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("uses ESTACODA_HOME before HOME for the default store path", () => {
    const prodHome = join(tempDir, "prod-home");
    const devHome = join(tempDir, "dev-home");
    const previousHome = process.env.HOME;
    const previousEstacodaHome = process.env.ESTACODA_HOME;
    process.env.HOME = prodHome;
    process.env.ESTACODA_HOME = devHome;
    try {
      const store = new PersistentCliSessionStore();

      expect(store.path).toBe(join(devHome, ".estacoda", "cli-sessions.json"));
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousEstacodaHome === undefined) {
        delete process.env.ESTACODA_HOME;
      } else {
        process.env.ESTACODA_HOME = previousEstacodaHome;
      }
    }
  });

  it("keeps explicit path overrides ahead of homeDir", () => {
    const explicitPath = join(tempDir, "explicit-cli-sessions.json");
    const store = new PersistentCliSessionStore({
      path: explicitPath,
      homeDir: join(tempDir, "ignored-home")
    });

    expect(store.path).toBe(explicitPath);
  });
});

describe("resolveStartupSessionId", () => {
  it("uses a restored workspace session id when present", () => {
    expect(resolveStartupSessionId("restored-session", () => "new-session")).toBe("restored-session");
  });

  it("generates a session id when no workspace session was restored", () => {
    expect(resolveStartupSessionId(undefined, () => "new-session")).toBe("new-session");
  });

  it("prefers an explicitly selected session over a restored workspace session", () => {
    expect(resolveStartupSessionId("restored-session", () => "new-session", "selected-session"))
      .toBe("selected-session");
  });
});
