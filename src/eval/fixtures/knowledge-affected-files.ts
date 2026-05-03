import type { EvalCase, EvalResult } from "../../contracts/eval.js";
import { buildCodeDependencyGraph, affectedFiles } from "../../knowledge/code-dependency-graph.js";
import { assertTrue, assertContains, buildResult } from "../eval-runner.js";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const knowledgeAffectedFilesCase: EvalCase = {
  id: "knowledge-affected-files",
  name: "Affected-file lookup returns correct transitive dependents",
  description: "Parse a temp TS project with chain A→B→C and verify affected(A) includes B and C.",
  tags: ["knowledge", "code-graph", "deterministic"],
  run: async (): Promise<EvalResult> => {
    const startedAt = Date.now();
    const root = await mkdtemp(join(tmpdir(), "estacoda-eval-aff-"));

    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), `export const a = 1;`, "utf8");
    await writeFile(
      join(root, "src", "b.ts"),
      `import { a } from "./a";\nexport const b = a + 1;`,
      "utf8"
    );
    await writeFile(
      join(root, "src", "c.ts"),
      `import { b } from "./b";\nexport const c = b + 1;`,
      "utf8"
    );

    const graph = await buildCodeDependencyGraph({ workspaceRoot: root });
    const affected = affectedFiles(graph, join("src", "a.ts"));

    const assertions = [
      assertTrue("has 2 affected files", affected.length === 2),
      assertContains("includes b.ts", affected.join(","), join("src", "b.ts")),
      assertContains("includes c.ts", affected.join(","), join("src", "c.ts"))
    ];

    return buildResult(
      "knowledge-affected-files",
      "Affected-file lookup returns correct transitive dependents",
      assertions,
      Date.now() - startedAt
    );
  }
};
