import { writeFile, readFile, symlink, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { copyFixture } from "../test/copy-fixture.js";
import { prepareTemporaryCopy } from "./temporary-copy.js";
import { ChangeApplicationStore } from "./change-application.js";

it("finishes preauthorized binary and file changes without a second approval", async () => {
  const f = await copyFixture(), store = new ChangeApplicationStore(f);
  try {
    const target = await prepareTemporaryCopy({ ...f, source: "source", manifest: f.input });
    await store.authorize(target.id, { version: 1, outcome: "apply", paths: [{ path: "hello.bin", operations: ["update"] }, { path: "new.txt", operations: ["create"] }] });
    await writeFile(join(f.destination, "hello.bin"), Buffer.from([2, 0, 255])); await writeFile(join(f.destination, "new.txt"), "hello");
    expect((await store.finish(target.id, "session")).status).toBe("applied");
    expect(await readFile(join(f.source, "hello.bin"))).toEqual(Buffer.from([2, 0, 255]));
    expect(await readFile(join(f.source, "new.txt"), "utf8")).toBe("hello");
  } finally { store.close(); await f.cleanup(); }
});
it("preserves all source edits when any baseline conflicts", async () => {
  const f = await copyFixture(), store = new ChangeApplicationStore(f);
  try {
    const target = await prepareTemporaryCopy({ ...f, source: "source", manifest: f.input });
    await store.authorize(target.id, { version: 1, outcome: "apply", paths: [{ path: "hello.bin", operations: ["update"] }, { path: "new.txt", operations: ["create"] }] });
    await writeFile(join(f.destination, "hello.bin"), "agent"); await writeFile(join(f.destination, "new.txt"), "new");
    await writeFile(join(f.source, "hello.bin"), "user");
    expect((await store.finish(target.id, "session")).status).toBe("conflict");
    expect(await readFile(join(f.source, "hello.bin"), "utf8")).toBe("user");
    await expect(readFile(join(f.source, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { store.close(); await f.cleanup(); }
});
it("exports review-only requests and blocks changed destination containment or trust", async () => {
  const f = await copyFixture(), store = new ChangeApplicationStore(f);
  try {
    const target = await prepareTemporaryCopy({ ...f, source: "source", manifest: f.input });
    await writeFile(join(f.destination, "hello.bin"), "agent");
    expect((await store.finish(target.id, "s")).status).toBe("review");
    await store.authorize(target.id, { version: 1, outcome: "apply", paths: [{ path: "hello.bin", operations: ["update"] }] });
    await rm(join(f.source, "hello.bin")); await symlink("../outside", join(f.source, "hello.bin"));
    expect((await store.finish(target.id, "s")).status).toBe("attention");
    await store.trust.revoke(await realpath(f.source));
    expect((await store.finish(target.id, "s")).reason).toContain("trust");
  } finally { store.close(); await f.cleanup(); }
});
