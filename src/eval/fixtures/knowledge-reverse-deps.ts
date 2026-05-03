import type { EvalCase, EvalResult } from "../../contracts/eval.js";
import { buildCodeDependencyGraph, reverseDeps } from "../../knowledge/code-dependency-graph.js";
import { assertTrue, assertContains, buildResult } from "../eval-runner.js";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const knowledgeReverseDepsCase: EvalCase = {
  id: "knowledge-reverse-deps",
  name: "Reverse dependency lookup returns correct direct importers",
  description: "Parse a temp TS project and verify reverse deps match expected importers.",
  tags: ["knowledge", "code-graph", "deterministic"],
  run: async (): Promise<EvalResult> => {
    const startedAt = Date.now();
    const root = await mkdtemp(join(tmpdir(), "estacoda-eval-rev-"));

    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "shared.ts"), `export const shared = 1;`, "utf8");
    await writeFile(
      join(root, "src", "a.ts"),
      `import { shared } from "./shared";\nconsole.log(shared);`,
      "utf8"
    );
    await writeFile(
      join(root, "src", "b.ts"),
      `import { shared } from "./shared";\nexport function useShared() { return shared; }`,
      "utf8"
    );

    const graph = await buildCodeDependencyGraph({ workspaceRoot: root });
    const rdeps = reverseDeps(graph, join("src", "shared.ts"));

    const assertions = [
      assertTrue("has 2 reverse deps", rdeps.length === 2),
      assertContains("includes a.ts", rdeps.join(","), join("src", "a.ts")),
      assertContains("includes b.ts", rdeps.join(","), join("src", "b.ts"))
    ];

    return buildResult(
      "knowledge-reverse-deps",
      "Reverse dependency lookup returns correct direct importers",
      assertions,
      Date.now() - startedAt
    );
  }
};
