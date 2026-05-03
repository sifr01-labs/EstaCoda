import type { EvalCase, EvalResult } from "../../contracts/eval.js";
import { buildCodeDependencyGraph, graphSummary } from "../../knowledge/code-dependency-graph.js";
import { assertEqual, buildResult } from "../eval-runner.js";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const knowledgeGraphSummaryCase: EvalCase = {
  id: "knowledge-graph-summary",
  name: "Graph summary reports correct node and edge counts",
  description: "Parse a temp TS project and verify summary counts match expected.",
  tags: ["knowledge", "code-graph", "deterministic"],
  run: async (): Promise<EvalResult> => {
    const startedAt = Date.now();
    const root = await mkdtemp(join(tmpdir(), "estacoda-eval-sum-"));

    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "lib.ts"), `export function foo() {}`, "utf8");
    await writeFile(
      join(root, "src", "app.ts"),
      `import { foo } from "./lib";\nfoo();`,
      "utf8"
    );
    await writeFile(join(root, "src", "unused.ts"), `export function bar() {}`, "utf8");

    const graph = await buildCodeDependencyGraph({ workspaceRoot: root });
    const summary = graphSummary(graph);

    const assertions = [
      assertEqual("node count", summary.nodeCount, 3),
      assertEqual("edge count", summary.edgeCount, 1),
      assertEqual("isolated files count", summary.isolatedFiles.length, 1),
      assertEqual("external deps count", summary.externalDependencies.length, 0)
    ];

    return buildResult(
      "knowledge-graph-summary",
      "Graph summary reports correct node and edge counts",
      assertions,
      Date.now() - startedAt
    );
  }
};
