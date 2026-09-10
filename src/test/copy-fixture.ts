import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ExecutionTargetStore } from "../workspaces/execution-target.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
export async function copyFixture() {
  const homeDir = await mkdtemp(join(tmpdir(), "copy-tests-")), source = join(homeDir, "source"), destination = join(homeDir, "copy");
  await mkdir(source); await writeFile(join(source, "hello.bin"), Buffer.from([0, 255, 1])); await chmod(join(source, "hello.bin"), 0o755);
  const options = { homeDir, profileId: "work" };
  const store = new ExecutionTargetStore(options); await store.add("source", source); store.close();
  await new WorkspaceTrustStore(options).grant(source);
  return { ...options, source, destination, input: { version: 1, files: [{ path: "hello.bin", origin: "untracked" }] },
    cleanup: () => rm(homeDir, { recursive: true, force: true }) };
}
