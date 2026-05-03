import type { EvalCase, EvalResult } from "../../contracts/eval.js";
import { KnowledgeCache } from "../../knowledge/knowledge-cache.js";
import { assertTrue, assertEqual, buildResult } from "../eval-runner.js";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const knowledgeCacheInvalidatesCase: EvalCase = {
  id: "knowledge-cache-invalidates",
  name: "Cache invalidates when source files change",
  description: "Generate graph, modify a source file, assert next query produces a different graph.",
  tags: ["knowledge", "code-graph", "deterministic"],
  run: async (): Promise<EvalResult> => {
    const startedAt = Date.now();
    const root = await mkdtemp(join(tmpdir(), "estacoda-eval-cache-"));

    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), `export const a = 1;`, "utf8");
    await writeFile(
      join(root, "src", "b.ts"),
      `import { a } from "./a";\nconsole.log(a);`,
      "utf8"
    );

    const cache = new KnowledgeCache({ workspaceRoot: root });

    // First generation
    const graph1 = await cache.getGraph();
    const edgeCount1 = graph1.edges.length;

    // Modify source file to change dependencies
    await writeFile(
      join(root, "src", "b.ts"),
      `import { a } from "./a";\nimport { something } from "./new-lib";\nconsole.log(a);`,
      "utf8"
    );

    // Force a small delay so mtime changes
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Second generation should detect stale cache and regenerate
    const graph2 = await cache.getGraph();
    const edgeCount2 = graph2.edges.length;

    const assertions = [
      assertEqual("first graph has 1 edge", edgeCount1, 1),
      assertTrue("second graph has more edges", edgeCount2 > edgeCount1),
      assertTrue("second graph includes new-lib edge", graph2.edges.some((e) => e.to.includes("new-lib")))
    ];

    return buildResult(
      "knowledge-cache-invalidates",
      "Cache invalidates when source files change",
      assertions,
      Date.now() - startedAt
    );
  }
};
