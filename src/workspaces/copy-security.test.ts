import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, rm, link } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { copyFixture } from "../test/copy-fixture.js";
import { prepareTemporaryCopy } from "./temporary-copy.js";
import { ChangeApplicationStore } from "./change-application.js";
import { hash } from "./copy-files.js";
import { resolveProfileStateHome } from "../config/profile-home.js";
import { openDefaultSQLiteDatabase } from "../storage/factory.js";

it("handles tracked files, ignored dependencies and credential exclusions explicitly", async () => {
  const f = await copyFixture();
  try {
    const git = (args: string[]) => execFileSync("git", ["-C", f.source, ...args], { stdio: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
    git(["init"]); git(["add", "hello.bin"]);
    await writeFile(join(f.source, ".gitignore"), "dependency.bin\n.env\n");
    await writeFile(join(f.source, "dependency.bin"), "explicit dependency");
    const manifest = { version: 1, files: [{ path: "hello.bin", origin: "tracked" }, { path: "dependency.bin", origin: "dependency" }] };
    const target = await prepareTemporaryCopy({ ...f, source: "source", manifest });
    expect(await readFile(join(f.destination, "dependency.bin"), "utf8")).toBe("explicit dependency");
    await expect(readFile(join(f.destination, ".git/config"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(prepareTemporaryCopy({ ...f, destination: f.destination + "-ignored", source: "source", manifest: { version: 1, files: [{ path: "dependency.bin", origin: "untracked" }] } })).rejects.toThrow("Ignored");
    const store = new ChangeApplicationStore(f);
    try {
      await writeFile(join(f.destination, "dependency.bin"), "changed dependency");
      expect((await store.load((await store.export(target.id, "s")).id)).bundle.changes).toEqual([]);
      await expect(store.authorize(target.id, { version: 1, outcome: "apply", paths: [{ path: "dependency.bin", operations: ["update"] }] })).rejects.toThrow("source-manifest");
    } finally { store.close(); }
  } finally { await f.cleanup(); }
});
it("rejects profile-state roots, oversized input files and hard-linked sources", async () => {
  const f = await copyFixture();
  try {
    const destination = join(resolveProfileStateHome(f).profileRoot, "copy");
    await expect(prepareTemporaryCopy({ ...f, source: "source", destination, manifest: f.input })).rejects.toThrow("runtime or credential");
    await writeFile(join(f.source, "large.bin"), Buffer.alloc(8 * 1024 * 1024 + 1));
    await expect(prepareTemporaryCopy({ ...f, source: "source", manifest: { version: 1, files: [{ path: "large.bin", origin: "untracked" }] } })).rejects.toThrow("limits");
    await link(join(f.source, "hello.bin"), join(f.source, "linked"));
    await expect(prepareTemporaryCopy({ ...f, source: "source", manifest: f.input })).rejects.toThrow("unlinked regular");
  } finally { await f.cleanup(); }
});
it.each(["traversal", "profile", "baseline", "duplicate", "mutation", "target"])("rejects malicious %s even when outer storage hashes are recomputed", async (attack) => {
  const f = await copyFixture(), store = new ChangeApplicationStore(f);
  try {
    const target = await prepareTemporaryCopy({ ...f, source: "source", manifest: f.input });
    await writeFile(join(f.destination, "hello.bin"), "agent");
    const artifact = await store.export(target.id, "session");
    const body = JSON.parse(await readFile(artifact.localPath!, "utf8"));
    if (attack === "traversal") body.changes[0].path = "../outside";
    if (attack === "profile") body.profileId = "other";
    if (attack === "baseline") body.changes[0].before.sha256 = "0".repeat(64);
    if (attack === "duplicate") body.changes.push(body.changes[0]);
    if (attack === "mutation") body.changes[0].operation = "delete";
    if (attack === "target") body.target.targetGeneration++;
    const bytes = Buffer.from(JSON.stringify(body)); await writeFile(artifact.localPath!, bytes);
    const db = openDefaultSQLiteDatabase({ path: join(resolveProfileStateHome(f).profileRoot, "workspaces.sqlite") });
    try {
      const row = db.query<{ record_json: string }>("select record_json from workspace_change_artifacts where id=?").get(artifact.id)!;
      const registration = JSON.parse(row.record_json); registration.bytes = bytes.length; registration.sha256 = hash(bytes);
      db.query("update workspace_change_artifacts set record_json=? where id=?").run(JSON.stringify(registration), artifact.id);
      expect(db.query<{ user_version: number }>("pragma user_version").get()!.user_version).toBe(2);
    } finally { db.close(); }
    await expect(store.load(artifact.id)).rejects.toThrow();
    expect(await readFile(join(f.source, "hello.bin"))).toEqual(Buffer.from([0, 255, 1]));
  } finally { store.close(); await f.cleanup(); }
});
it("requires explicit delete authority and keeps profile ownership separate", async () => {
  const f = await copyFixture(), store = new ChangeApplicationStore(f), other = new ChangeApplicationStore({ homeDir: f.homeDir, profileId: "other" });
  try {
    const target = await prepareTemporaryCopy({ ...f, source: "source", manifest: f.input });
    const authorization = await store.authorize(target.id, { version: 1, outcome: "apply", paths: [{ path: "hello.bin", operations: ["delete"] }] });
    expect(authorization.grant?.riskClass).toBe("destructive-local");
    await rm(join(f.destination, "hello.bin"));
    const result = await store.finish(target.id, "session"); expect(result.status, result.reason).toBe("applied");
    await expect(other.load(result.artifact.id)).rejects.toThrow("selected profile");
    expect((await store.recover(result.artifact.id)).status).toBe("review");
    expect(await readFile(join(f.source, "hello.bin"))).toEqual(Buffer.from([0, 255, 1]));
  } finally { store.close(); other.close(); await f.cleanup(); }
});
