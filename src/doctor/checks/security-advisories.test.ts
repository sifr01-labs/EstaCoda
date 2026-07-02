import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AdvisoryAckStore } from "../advisory-store.js";
import type { SecurityAdvisory } from "../advisory-db.js";
import { diagnoseSecurityAdvisories } from "./security-advisories.js";

const tempDirs: string[] = [];

const HIGH_ADVISORY: SecurityAdvisory = {
  id: "GHSA-fixture-high",
  packageName: "fixture-vuln",
  affectedVersions: "<1.3.0",
  severity: "high",
  title: "Fixture package vulnerability",
  recommendation: "upgrade fixture-vuln to 1.3.0 or later"
};

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "estacoda-security-advisories-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("diagnoseSecurityAdvisories", () => {
  it("reports active bundled advisories for affected direct dependencies", async () => {
    const workspaceRoot = await tempDir();
    const ackStore = new AdvisoryAckStore({ path: join(workspaceRoot, "profile", "advisories-acked.json") });
    await writeFile(join(workspaceRoot, "package.json"), JSON.stringify({
      dependencies: {
        "fixture-vuln": "1.2.0"
      }
    }), "utf8");

    const diagnostic = await diagnoseSecurityAdvisories({
      workspaceRoot,
      ackStore,
      advisories: [HIGH_ADVISORY]
    });

    expect(diagnostic.status).toBe("warning");
    expect(diagnostic.active).toEqual([
      expect.objectContaining({
        id: "GHSA-fixture-high",
        packageName: "fixture-vuln",
        installedVersion: "1.2.0",
        severity: "high"
      })
    ]);
    expect(diagnostic.warnings).toEqual([
      "Security advisory GHSA-fixture-high (high) affects fixture-vuln@1.2.0: Fixture package vulnerability. Recommendation: upgrade fixture-vuln to 1.3.0 or later"
    ]);
  });

  it("matches transitive package versions from pnpm-lock.yaml", async () => {
    const workspaceRoot = await tempDir();
    const ackStore = new AdvisoryAckStore({ path: join(workspaceRoot, "profile", "advisories-acked.json") });
    await writeFile(join(workspaceRoot, "package.json"), JSON.stringify({ dependencies: {} }), "utf8");
    await writeFile(join(workspaceRoot, "pnpm-lock.yaml"), [
      "lockfileVersion: '9.0'",
      "packages:",
      "  fixture-transitive@2.0.0:",
      "    resolution: {integrity: sha512-test}"
    ].join("\n"), "utf8");

    const diagnostic = await diagnoseSecurityAdvisories({
      workspaceRoot,
      ackStore,
      advisories: [{
        id: "GHSA-fixture-transitive",
        packageName: "fixture-transitive",
        affectedVersions: ">=2.0.0 <2.0.1",
        severity: "moderate",
        title: "Fixture transitive vulnerability",
        recommendation: "upgrade fixture-transitive to 2.0.1 or later"
      }]
    });

    expect(diagnostic.status).toBe("warning");
    expect(diagnostic.active).toEqual([
      expect.objectContaining({
        id: "GHSA-fixture-transitive",
        installedVersion: "2.0.0"
      })
    ]);
  });

  it("suppresses acknowledged advisories and records the active acknowledgement note", async () => {
    const workspaceRoot = await tempDir();
    const ackStore = new AdvisoryAckStore({ path: join(workspaceRoot, "profile", "advisories-acked.json") });
    await ackStore.acknowledge("GHSA-fixture-high");
    await writeFile(join(workspaceRoot, "package.json"), JSON.stringify({
      dependencies: {
        "fixture-vuln": "1.2.0"
      }
    }), "utf8");

    const diagnostic = await diagnoseSecurityAdvisories({
      workspaceRoot,
      ackStore,
      advisories: [HIGH_ADVISORY]
    });

    expect(diagnostic.status).toBe("ready");
    expect(diagnostic.active).toEqual([]);
    expect(diagnostic.warnings).toEqual([]);
    expect(diagnostic.notes).toEqual(["1 security advisory acknowledgement(s) active."]);
  });

  it("blocks on unacknowledged critical advisories", async () => {
    const workspaceRoot = await tempDir();
    const ackStore = new AdvisoryAckStore({ path: join(workspaceRoot, "profile", "advisories-acked.json") });
    await writeFile(join(workspaceRoot, "package.json"), JSON.stringify({
      dependencies: {
        "fixture-vuln": "1.2.0"
      }
    }), "utf8");

    const diagnostic = await diagnoseSecurityAdvisories({
      workspaceRoot,
      ackStore,
      advisories: [{
        ...HIGH_ADVISORY,
        id: "GHSA-fixture-critical",
        severity: "critical"
      }]
    });

    expect(diagnostic.status).toBe("blocked");
    expect(diagnostic.active).toEqual([
      expect.objectContaining({
        id: "GHSA-fixture-critical",
        severity: "critical"
      })
    ]);
  });

  it("sanitizes malformed acknowledgement store failures", async () => {
    const workspaceRoot = await tempDir();
    const ackPath = join(workspaceRoot, "profile", "advisories-acked.json");
    const ackStore = new AdvisoryAckStore({ path: ackPath });
    await writeFile(join(workspaceRoot, "package.json"), JSON.stringify({
      dependencies: {
        "fixture-vuln": "1.2.0"
      }
    }), "utf8");
    await mkdir(join(workspaceRoot, "profile"), { recursive: true });
    await writeFile(ackPath, "{", "utf8");

    const diagnostic = await diagnoseSecurityAdvisories({
      workspaceRoot,
      ackStore,
      advisories: [HIGH_ADVISORY]
    });

    expect(diagnostic.status).toBe("warning");
    expect(diagnostic.active).toEqual([]);
    expect(diagnostic.warnings).toEqual(["Security advisory acknowledgements could not be read."]);
    expect(JSON.stringify(diagnostic)).not.toContain(workspaceRoot);
  });
});
