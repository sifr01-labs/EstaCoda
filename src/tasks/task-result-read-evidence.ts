import { createHash } from "node:crypto";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";

/** Reassemble only successful, complete, integrity-matching accepted result pages. */
export function readTaskResultEvidence(executions: readonly ToolExecutionRecord[], taskId: string) {
  const pages = new Map<string, { hash: string; total: number; primary: boolean; researchComplete?: boolean; parts: Map<number, string> }>();
  for (const execution of executions) {
    const m = execution.result?.metadata;
    if (execution.tool.name !== "task.result.read" || execution.decision !== "allow" || execution.result?.ok !== true ||
      m?.taskId !== taskId || m.disposition !== "accepted" || typeof m.resultId !== "string" ||
      typeof m.contentHash !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(m.contentHash) ||
      !Number.isSafeInteger(m.totalChars) || Number(m.totalChars) < 1 || Number(m.totalChars) > 256_000 ||
      !Number.isSafeInteger(m.offset) || Number(m.offset) < 0) continue;
    let page = pages.get(m.resultId);
    if (page === undefined || page.hash !== m.contentHash || page.total !== m.totalChars) {
      page = { hash: m.contentHash, total: Number(m.totalChars), primary: m.primary === true,
        ...(typeof m.researchComplete === "boolean" ? { researchComplete: m.researchComplete } : {}), parts: new Map() };
      pages.set(m.resultId, page);
    }
    if (pages.size > 64) return [];
    page.parts.set(Number(m.offset), execution.result.content);
  }
  return [...pages].flatMap(([id, page]) => {
    let offset = 0;
    let content = "";
    for (const [start, text] of [...page.parts].sort(([a], [b]) => a - b)) {
      if (start !== offset) return [];
      offset += Array.from(text).length;
      if (offset > page.total) return [];
      content += text;
    }
    if (offset !== page.total || `sha256:${createHash("sha256").update(content).digest("hex")}` !== page.hash) return [];
    return [{ id, content, contentHash: page.hash, primary: page.primary, researchComplete: page.researchComplete }];
  });
}
