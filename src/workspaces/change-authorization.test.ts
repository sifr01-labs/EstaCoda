import { expect, it } from "vitest";
import { copyFixture } from "../test/copy-fixture.js";
import { prepareTemporaryCopy } from "./temporary-copy.js";
import { ChangeAuthorizationStore } from "./change-authorization.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
it("uses task-start exact path/mutation scope and honors existing approval revocation", async () => {
  const f = await copyFixture(), store = new ChangeAuthorizationStore(f);
  try {
    const target = await prepareTemporaryCopy({ ...f, source: "source", manifest: f.input });
    const authorization = await store.authorize(target.id, { version: 1, outcome: "apply", paths: [{ path: "hello.bin", operations: ["update"] }] });
    await writeFile(join(f.destination, "hello.bin"), "changed");
    let registration: import('../contracts/artifact.js').SessionArtifactRegistration | undefined;
    const { bundle } = await store.load((await store.export(target.id, "s", async value => { registration = value; })).id);
    expect(registration?.provenance).toMatchObject({sourceWorkspaceId:target.source.registeredWorkspaceId,applicationTargetId:authorization.applicationTargetId});
    expect(store.getTarget(authorization.applicationTargetId!)?.workspace.identityHash).toBe(target.source.identity.identityHash);
    const check = await store.checkAuthorization(bundle); check();
    await expect(store.checkAuthorization({ ...bundle, changes: [{ ...bundle.changes[0]!, operation: "delete" }] })).rejects.toThrow("exceed");
    expect(await store.approvals.revoke(authorization.grant!.id, authorization.grant!.workspaceRoot)).toBe(true);
    expect(check).toThrow("revoked");
  } finally { store.close(); await f.cleanup(); }
});
it("keeps review-only copies review-only and rejects dependency or missing-baseline updates", async () => {
  const f = await copyFixture(), store = new ChangeAuthorizationStore(f);
  try {
    const target = await prepareTemporaryCopy({ ...f, source: "source", manifest: f.input });
    await expect(store.authorize(target.id, { version: 1, outcome: "apply", paths: [{ path: "other", operations: ["update"] }] })).rejects.toThrow("source-manifest");
    await store.authorize(target.id, { version: 1, outcome: "review", paths: [] });
    const { bundle } = await store.load((await store.export(target.id, "s")).id);
    await expect(store.checkAuthorization(bundle)).rejects.toThrow("Review-only");
    await expect(store.authorize(target.id, { version: 1, outcome: "apply", paths: [{ path: "hello.bin", operations: ["update"] }] })).rejects.toThrow("already fixed");
  } finally { store.close(); await f.cleanup(); }
});
