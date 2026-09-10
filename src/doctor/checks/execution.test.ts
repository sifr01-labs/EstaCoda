import { it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { diagnoseExecution } from "./execution.js";
import { WorkspaceTrustStore } from "../../security/workspace-trust-store.js";
import { resolveProfileStateHome } from "../../config/profile-home.js";
it("reports trust and policy blockers without leaking paths or acquiring execution", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "doctor-execution-"));
  const input = { homeDir, workspaceRoot: homeDir, profileId: "default", locale: "en" as const };
  let calls = 0;
  const connect = async (): Promise<never> => { calls++; throw new Error(homeDir); };
  try {
    expect((await diagnoseExecution(input, connect)).severity).toBe("blocked");
    await new WorkspaceTrustStore(input).grant(homeDir);
    expect((await diagnoseExecution(input, connect)).severity).toBe("healthy");
    expect(calls).toBe(0);
    const path = resolveProfileStateHome(input).configPath;
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify({ execution: { backend: "docker", imageId: `sha256:${"a".repeat(64)}` } }));
    const blocked = await diagnoseExecution(input, connect);
    expect(calls).toBe(1); expect(blocked.severity).toBe("blocked");
    expect(JSON.stringify(blocked)).not.toContain(homeDir);
    expect((await diagnoseExecution({ ...input, locale: "ar" }, connect)).label).toBe("بيئة التنفيذ");
  } finally { await rm(homeDir, { recursive: true, force: true }); }
});
