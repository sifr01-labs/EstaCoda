import type { EvalCase, EvalResult } from "../../contracts/eval.js";
import { buildCodeDependencyGraph, forwardDeps } from "../../knowledge/code-dependency-graph.js";
import { assertTrue, assertContains, buildResult } from "../eval-runner.js";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const knowledgeForwardDepsCase: EvalCase = {
  id: "knowledge-forward-deps",
  name: "Forward dependency lookup returns correct direct imports",
  description: "Parse a temp TS project and verify forward deps match expected imports.",
  tags: ["knowledge", "code-graph", "deterministic"],
  run: async (): Promise<EvalResult> => {
    const startedAt = Date.now();
    const root = await mkdtemp(join(tmpdir(), "estacoda-eval-fwd-"));

    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "utils.ts"), `export function helper() { return 42; }`, "utf8");
    await writeFile(join(root, "src", "types.ts"), `export type MyType = string;`, "utf8");
    await writeFile(
      join(root, "src", "main.ts"),
      `import { helper } from "./utils";\nimport type { MyType } from "./types";\nconsole.log(helper());`,
      "utf8"
    );

    const graph = await buildCodeDependencyGraph({ workspaceRoot: root });
    const deps = forwardDeps(graph, join("src", "main.ts"));

    const assertions = [
      assertTrue("has 2 forward deps", deps.length === 2),
      assertContains("includes utils", deps.join(","), join("src", "utils.ts")),
      assertContains("includes types", deps.join(","), join("src", "types.ts"))
    ];

    return buildResult(
      "knowledge-forward-deps",
      "Forward dependency lookup returns correct direct imports",
      assertions,
      Date.now() - startedAt
    );
  }
};
