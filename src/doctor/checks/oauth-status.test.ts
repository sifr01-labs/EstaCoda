import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProfileStateHome } from "../../config/profile-home.js";
import { CURRENT_OAUTH_STORE_VERSION } from "../../providers/oauth/oauth-types.js";
import { diagnoseOAuthStatus } from "./oauth-status.js";

const tempDirs: string[] = [];

async function tempHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "estacoda-doctor-oauth-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("diagnoseOAuthStatus", () => {
  it("treats an empty auth store as ready with a note", async () => {
    const homeDir = await tempHome();

    const diagnostic = await diagnoseOAuthStatus({ homeDir, profileId: "default" });

    expect(diagnostic.status).toBe("ready");
    expect(diagnostic.providerStatuses).toEqual([]);
    expect(diagnostic.warnings).toEqual([]);
    expect(diagnostic.notes).toEqual(["OAuth auth store has no provider records."]);
  });

  it("reports ready and expired providers without exposing tokens", async () => {
    const homeDir = await tempHome();
    const authPath = resolveProfileStateHome({ homeDir, profileId: "default" }).authJsonPath;
    await mkdir(dirname(authPath), { recursive: true });
    await writeFile(authPath, `${JSON.stringify({
      version: CURRENT_OAUTH_STORE_VERSION,
      providers: {
        codex: {
          authMethod: "oauth_device_pkce",
          accessToken: "secret-access-token",
          refreshToken: "secret-refresh-token",
          expiresAt: "2025-01-01T00:00:00.000Z"
        },
        research: {
          authMethod: "oauth_external",
          accessToken: "other-secret"
        }
      }
    })}\n`, "utf8");

    const diagnostic = await diagnoseOAuthStatus({
      homeDir,
      profileId: "default",
      now: new Date("2026-01-01T00:00:00.000Z")
    });

    expect(diagnostic.status).toBe("warning");
    expect(diagnostic.providerStatuses).toEqual([
      { providerId: "codex", authMethod: "oauth_device_pkce", status: "expired" },
      { providerId: "research", authMethod: "oauth_external", status: "ready" }
    ]);
    expect(diagnostic.warnings).toEqual(["OAuth credentials are expired for providers: codex"]);
    expect(diagnostic.warnings.join("\n")).not.toContain("secret-access-token");
    expect(diagnostic.warnings.join("\n")).not.toContain("secret-refresh-token");
  });

  it("surfaces malformed auth stores as warnings", async () => {
    const homeDir = await tempHome();
    const authPath = resolveProfileStateHome({ homeDir, profileId: "default" }).authJsonPath;
    await mkdir(dirname(authPath), { recursive: true });
    await writeFile(authPath, "{not-json", "utf8");

    const diagnostic = await diagnoseOAuthStatus({ homeDir, profileId: "default" });

    expect(diagnostic.status).toBe("warning");
    expect(diagnostic.warnings).toEqual(["auth.json contains invalid JSON; treating as empty store."]);
  });
});
