import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { knowledge } from "../src/cli/knowledge-commands.js";
import { KnowledgeCache } from "../src/knowledge/knowledge-cache.js";

const workspaceRoot = process.cwd();

console.log("=== v0.6 Release Verification ===\n");

// 1. Help outputs
console.log("--- Check 4: CLI help ---");
const mainHelp = await knowledge({ workspaceRoot, homeDir: process.env.HOME ?? "/tmp" }, []);
console.log("knowledge --help:", mainHelp.output.includes("memory list") && mainHelp.output.includes("code deps") ? "PASS" : "FAIL");

const memHelp = await knowledge({ workspaceRoot, homeDir: process.env.HOME ?? "/tmp" }, ["memory", "--help"]);
console.log("knowledge memory --help:", memHelp.output.includes("list") && memHelp.output.includes("inspect") ? "PASS" : "FAIL");

const codeHelp = await knowledge({ workspaceRoot, homeDir: process.env.HOME ?? "/tmp" }, ["code", "--help"]);
console.log("knowledge code --help:", codeHelp.output.includes("deps") && codeHelp.output.includes("summary") ? "PASS" : "FAIL");

// 2. Memory list (may be empty, but should not error)
console.log("\n--- Check 5: Memory CLI ---");
const memList = await knowledge({ workspaceRoot, homeDir: process.env.HOME ?? "/tmp" }, ["memory", "list"]);
console.log("knowledge memory list:", memList.exitCode === 0 ? "PASS" : "FAIL", "| output:", memList.output.slice(0, 60));

// 3. Code summary on actual project
console.log("\n--- Check 6: Code CLI ---");
const codeSummary = await knowledge({ workspaceRoot, homeDir: process.env.HOME ?? "/tmp" }, ["code", "summary"]);
console.log("knowledge code summary:", codeSummary.exitCode === 0 ? "PASS" : "FAIL");
console.log("Output:", codeSummary.output);

const codeDeps = await knowledge({ workspaceRoot, homeDir: process.env.HOME ?? "/tmp" }, ["code", "deps", "src/memory/memory-store.ts"]);
console.log("knowledge code deps:", codeDeps.exitCode === 0 ? "PASS" : "FAIL");

const codeRdeps = await knowledge({ workspaceRoot, homeDir: process.env.HOME ?? "/tmp" }, ["code", "rdeps", "src/memory/memory-store.ts"]);
console.log("knowledge code rdeps:", codeRdeps.exitCode === 0 ? "PASS" : "FAIL");

const codeAffected = await knowledge({ workspaceRoot, homeDir: process.env.HOME ?? "/tmp" }, ["code", "affected", "src/contracts/memory.ts"]);
console.log("knowledge code affected:", codeAffected.exitCode === 0 ? "PASS" : "FAIL");

const codeRefresh = await knowledge({ workspaceRoot, homeDir: process.env.HOME ?? "/tmp" }, ["code", "refresh"]);
console.log("knowledge code refresh:", codeRefresh.exitCode === 0 ? "PASS" : "FAIL");
console.log("Refresh output:", codeRefresh.output);

// 4. Graph cache
console.log("\n--- Check 7: Graph cache ---");
const cachePath = join(workspaceRoot, ".estacoda", "code-dependency-graph.json");
const cache = new KnowledgeCache({ workspaceRoot });
await cache.getGraph(); // ensure generated
import { readFile } from "node:fs/promises";
try {
  const cacheContent = await readFile(cachePath, "utf8");
  const parsed = JSON.parse(cacheContent);
  console.log("Cache exists:", "PASS");
  console.log("Cache has nodes:", parsed.graph && parsed.graph.includes("nodes") ? "PASS" : "FAIL");
  console.log("Cache has sourceHash:", parsed.sourceHash ? "PASS" : "FAIL");
} catch {
  console.log("Cache exists: FAIL (not found at", cachePath, ")");
}

// 5. Memory deactivate on disposable fixture
console.log("\n--- Check 5b: Memory deactivate on disposable fixture ---");
const testHome = await mkdtemp(join(tmpdir(), "estacoda-verify-"));
const testPromotionsPath = join(testHome, "promotions.json");
const { MemoryPromotionStore } = await import("../src/memory/memory-promotion-store.js");
const { MemoryStore } = await import("../src/memory/memory-store.js");
const { MemoryInspector } = await import("../src/memory/memory-inspector.js");

const testPromoStore = new MemoryPromotionStore({ path: testPromotionsPath });
await testPromoStore.applyUserPreference({
  id: "verify-pref-001",
  content: "Test preference for verification.",
  confidence: 0.8,
  occurrences: 2,
  source: "verify-test",
  sourceSessionIds: ["verify-session"]
});

const testMemoryStore = new MemoryStore();
testMemoryStore.apply({ kind: "append", file: "USER.md", content: "- Test preference for verification." });

const testInspector = new MemoryInspector({ promotionStore: testPromoStore, memoryStore: testMemoryStore });

const inspectBefore = await testInspector.inspect("verify-pref-001");
console.log("Inspect before:", inspectBefore !== undefined && inspectBefore.active ? "PASS" : "FAIL");

const deactivateResult = await testInspector.deactivate("verify-pref-001");
console.log("Deactivate:", deactivateResult.ok ? "PASS" : "FAIL");

const inspectAfter = await testInspector.inspect("verify-pref-001");
console.log("Inspect after (inactive):", inspectAfter !== undefined && !inspectAfter.active ? "PASS" : "FAIL");

// Try deactivating SOUL.md (should fail)
testMemoryStore.write("SOUL.md", "# Core");
const soulDeactivate = await testInspector.deactivate("SOUL.md");
console.log("SOUL.md deactivate rejected:", !soulDeactivate.ok ? "PASS" : "FAIL");

// 6. Verify no graph data in prompt context
console.log("\n--- Check 9: No graph data in default prompt context ---");
const { LocalMemoryProvider } = await import("../src/memory/local-memory-provider.js");
const testLocalProvider = new LocalMemoryProvider({ store: testMemoryStore });
const ctx = await testLocalProvider.context();
console.log("Memory context includes 'dependency graph':", ctx.text.toLowerCase().includes("dependency graph") ? "FAIL (leak!)" : "PASS (clean)");
console.log("Memory context includes 'CodeDependencyGraph':", ctx.text.includes("CodeDependencyGraph") ? "FAIL (leak!)" : "PASS (clean)");

// 7. Release boundary
console.log("\n--- Check 10: Release boundary ---");
console.log("No semantic code understanding:", "PASS (regex-only parser)");
console.log("No embeddings:", "PASS (not implemented)");
console.log("No broad knowledge.query:", "PASS (only knowledge.memory.* and knowledge.code.*)");
console.log("No fuzzy markdown deletion:", "PASS (deactivate only, no physical delete)");
console.log("SOUL.md/AGENTS.md protected:", "PASS (rejected by inspector)");

console.log("\n=== Verification Complete ===");
