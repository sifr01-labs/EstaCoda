import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { copyFixture } from "../test/copy-fixture.js";
import { prepareTemporaryCopy } from "./temporary-copy.js";
import { ChangeApplicationStore } from "./change-application.js";

it.each(["renameSync", "linkSync"])("recovers a real process exit after %s before its progress receipt", async (operation) => {
  const f = await copyFixture(), store = new ChangeApplicationStore(f);
  try {
    const target = await prepareTemporaryCopy({ ...f, source: "source", manifest: f.input });
    await store.authorize(target.id, { version: 1, outcome: "apply", paths: [{ path: "hello.bin", operations: ["update"] }, { path: "new.txt", operations: ["create"] }] });
    await writeFile(join(f.destination, "hello.bin"), "agent"); await writeFile(join(f.destination, "new.txt"), "new");
    const artifact = await store.export(target.id, "s");
    const script = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      const original = fs[${JSON.stringify(operation)}];
      fs[${JSON.stringify(operation)}] = (...args) => { const result = original(...args); if (String(args[1]).startsWith(${JSON.stringify(target.source.identity.canonicalPath + "/")})) process.exit(73); return result; }; syncBuiltinESMExports();
      const {ChangeApplicationStore} = await import(${JSON.stringify(new URL("./change-application.ts", import.meta.url).href)});
      const store = new ChangeApplicationStore(${JSON.stringify({ homeDir: f.homeDir, profileId: f.profileId })});
      await store.apply(${JSON.stringify(artifact.id)}); process.exit(74);`;
    await expect(promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script], { timeout: 15000 })).rejects.toMatchObject({ code: 73 });
    expect((await store.apply(artifact.id)).status).toBe("attention");
    const recovered = await store.recover(artifact.id); expect(recovered.status, recovered.reason).toBe("review");
    expect(await readFile(join(f.source, "hello.bin"))).toEqual(Buffer.from([0, 255, 1]));
    await expect(readFile(join(f.source, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await store.recover(artifact.id)).reason).toContain("already rolled back");
  } finally { store.close(); await f.cleanup(); }
});
it("preserves later user edits during rollback and makes successful application retries inert", async () => {
  const f = await copyFixture(), store = new ChangeApplicationStore(f);
  try {
    const target = await prepareTemporaryCopy({ ...f, source: "source", manifest: f.input });
    await store.authorize(target.id, { version: 1, outcome: "apply", paths: [{ path: "hello.bin", operations: ["update"] }] });
    await writeFile(join(f.destination, "hello.bin"), "agent");
    const result = await store.finish(target.id, "s"); expect(result.status).toBe("applied");
    await writeFile(join(f.source, "hello.bin"), "later user edit");
    expect((await store.apply(result.artifact.id)).status).toBe("applied");
    const recovery = await store.recover(result.artifact.id);
    expect(recovery.status).toBe("attention"); expect(recovery.paths).toEqual(["hello.bin"]);
    expect(await readFile(join(f.source, "hello.bin"), "utf8")).toBe("later user edit");
  } finally { store.close(); await f.cleanup(); }
});
