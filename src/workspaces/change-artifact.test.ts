import { writeFile, readFile, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { copyFixture } from "../test/copy-fixture.js";
import { prepareTemporaryCopy } from "./temporary-copy.js";
import { ChangeArtifactStore } from "./change-artifact.js";
it("exports immutable profile-owned create/update/delete changes through the artifact store", async () => {
  const f = await copyFixture(), store = new ChangeArtifactStore(f);
  try {
    const target = await prepareTemporaryCopy({ ...f, source: "source", manifest: f.input });
    await writeFile(join(f.destination, "new.txt"), "new"); await chmod(join(f.destination, "hello.bin"), 0o644);
    const artifact = await store.export(target.id, "session");
    const { bundle } = await store.load(artifact.id);
    expect(bundle.changes.map((change) => change.operation)).toEqual(["update", "create"]);
    expect(store.artifacts.get(artifact.id, { profileId: "other", sessionId: "session" })).toBeUndefined();
    expect(await readFile(join(f.source, "hello.bin"))).toEqual(Buffer.from([0, 255, 1]));
    await rm(join(f.destination, "hello.bin"));
    const deleted = await store.load((await store.export(target.id, "session")).id);
    expect(deleted.bundle.changes[0]!.operation).toBe("delete");
    await writeFile(artifact.localPath!, "{}"); await expect(store.load(artifact.id)).rejects.toThrow("altered");
  } finally { store.close(); await f.cleanup(); }
});
