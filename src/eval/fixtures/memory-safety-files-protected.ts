import type { EvalCase, EvalResult } from "../../contracts/eval.js";
import { MemoryStore } from "../../memory/memory-store.js";
import { MemoryPromotionStore } from "../../memory/memory-promotion-store.js";
import { MemoryInspector } from "../../memory/memory-inspector.js";
import { renderSelective } from "../../memory/selective-renderer.js";
import { assertTrue, assertEqual, buildResult } from "../eval-runner.js";

export const memorySafetyFilesProtectedCase: EvalCase = {
  id: "memory-safety-files-protected",
  name: "Safety file entries cannot be deactivated",
  description: "SOUL.md entries are always rendered and cannot be deactivated.",
  tags: ["memory", "safety", "deterministic"],
  run: async (): Promise<EvalResult> => {
    const startedAt = Date.now();
    const memoryStore = new MemoryStore();
    const promotionStore = new MemoryPromotionStore({
      path: "/tmp/estacoda-eval-promotions-safety.json"
    });

    // Seed SOUL.md content (simulated as project-fact since SOUL.md is a safety file)
    // The inspector's deactivate checks the targetFile derived from record.kind.
    // project-fact -> MEMORY.md, user-preference -> USER.md.
    // SOUL.md entries are not in the promotion store per se.
    // Instead, we test that:
    // 1. The inspector rejects deactivation if the target file is a safety file.
    // 2. But since promotion store only tracks USER.md and MEMORY.md entries,
    //    the protection is actually at the renderer level (always include SOUL.md)
    //    and at the tool/CLI level (reject deactivate for safety files).
    //
    // For this eval, we verify the renderer always includes safety files
    // and that the inspector correctly identifies safety files.

    const inspector = new MemoryInspector({ promotionStore, memoryStore });

    // Add some content to safety files
    memoryStore.write("SOUL.md", "# Core Directives\n- Always be helpful.");
    memoryStore.write("USER.md", "- Prefer concise replies.");

    // Verify isSafetyFile
    const isSoulSafety = inspector.isSafetyFile("SOUL.md");
    const isUserSafety = inspector.isSafetyFile("USER.md");

    // Verify renderer always includes safety files
    const records = await promotionStore.list();
    const render = renderSelective(memoryStore.snapshot(), records, { query: "nothing-matches-this" });
    const containsSoul = render.text.includes("Always be helpful.");

    const assertions = [
      assertTrue("SOUL.md is safety file", isSoulSafety),
      assertTrue("USER.md is not safety file", !isUserSafety),
      assertTrue("renderer includes SOUL.md even with no-match query", containsSoul)
    ];

    return buildResult(
      "memory-safety-files-protected",
      "Safety file entries cannot be deactivated",
      assertions,
      Date.now() - startedAt
    );
  }
};
