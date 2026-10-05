import { readTaskResultEvidence } from "../tasks/task-result-read-evidence.js";
import { posix } from "node:path";
import type { ExecutionEvidenceRecord } from "../contracts/execution-plan.js";
import type { RequestRequirements } from "../contracts/intent.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";

export type FileOutputEvidence =
  | { satisfied: true; writeCallId?: string; path?: string }
  | { satisfied: false; reason: "unresolved-target" | "missing-write" | "missing-readback" | "missing-research-result" | "report-content-mismatch" };

/** Reconciles executor-owned call identities with workspace-tool results from
 * this turn. Provider prose, artifact handles and unrelated tools cannot qualify. */
export function fileOutputEvidence(input: {
  requirements?: RequestRequirements;
  toolExecutions: readonly ToolExecutionRecord[];
  executionReceipts: readonly ExecutionEvidenceRecord[];
}): FileOutputEvidence {
  const requirement = input.requirements?.fileOutput;
  if (requirement === undefined) return { satisfied: true };
  if (input.requirements?.issues.some((issue) => issue === "ambiguous-file-target" || issue === "unsafe-file-target")) {
    return { satisfied: false, reason: "unresolved-target" };
  }
  const receipts = new Map(input.executionReceipts.filter((receipt) =>
    input.requirements?.originTurnId === undefined || receipt.visibleTurnId === input.requirements.originTurnId
  ).map((receipt, index) => [receipt.toolCallId, { receipt, index }]));
  const result = input.requirements?.sourceTaskId === undefined ? undefined : readTaskResultEvidence(
    input.toolExecutions.filter((execution) => {
      const receipt = execution.toolCallId === undefined ? undefined : receipts.get(execution.toolCallId)?.receipt;
      return receipt?.status === "success" && receipt.tool === execution.tool.name;
    }), input.requirements.sourceTaskId).find((page) => page.primary);
  if (input.requirements?.sourceTaskId !== undefined && result === undefined) return { satisfied: false, reason: "missing-research-result" };
  let contentMismatch = false;
  const writes = new Map<string, { digest: string; callId: string; index: number }>();
  const verified = new Map<string, string>();
  for (const execution of input.toolExecutions) {
    const callId = execution.toolCallId;
    const recorded = callId === undefined ? undefined : receipts.get(callId);
    if (callId === undefined || recorded === undefined || recorded.receipt.tool !== execution.tool.name) continue;
    const metadata = execution.result?.metadata;
    const name = execution.tool.name;
    const touched = Array.isArray(metadata?.paths) ? metadata.paths : [metadata?.path ?? execution.input?.path];
    if (name === "file.read" || name === "file.write" || name === "file.patch") {
      for (const path of touched) {
        const target = safePath(path);
        if (target !== undefined) {
          verified.delete(target);
          if (name !== "file.read") writes.delete(target);
        }
      }
    }
    if (recorded.receipt.status !== "success" || execution.decision !== "allow" || execution.result?.ok !== true) continue;
    if (name === "file.write" || name === "file.patch") {
      const outputs = Array.isArray(metadata?.fileOutputs) ? metadata.fileOutputs : [metadata];
      for (const output of outputs) {
        if (output === null || typeof output !== "object") continue;
        const { path, contentSha256 } = output as Record<string, unknown>;
        const target = safePath(path);
        if (target === undefined || !matchesTarget(target, requirement) || !validDigest(contentSha256)) continue;
        if (result !== undefined && result.contentHash !== `sha256:${contentSha256}`) { contentMismatch = true; continue; }
        contentMismatch = false;
        writes.set(target, { digest: contentSha256, callId, index: recorded.index });
        verified.delete(target); // A later write invalidates an earlier readback.
      }
    }
    if (name !== "file.read" || metadata?.materialized !== true || (metadata.truncated === true && metadata.completeFileRead !== true) || typeof metadata.bytes !== "number" || metadata.bytes <= 0) continue;
    const target = safePath(metadata.path);
    const write = target === undefined ? undefined : writes.get(target);
    if (target !== undefined && write !== undefined && recorded.index > write.index && metadata.contentSha256 === write.digest) verified.set(target, write.callId);
  }
  const verifiedFile = verified.entries().next().value as [string, string] | undefined;
  return verifiedFile === undefined
    ? { satisfied: false, reason: contentMismatch ? "report-content-mismatch" : writes.size === 0 ? "missing-write" : "missing-readback" }
    : { satisfied: true, path: verifiedFile[0], writeCallId: verifiedFile[1] };
}

function safePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 240 || value.length === 0 || /^(?:[/\\]|[a-z]:)/iu.test(value)) return undefined;
  const path = value.replaceAll("\\", "/");
  return path.split("/").includes("..") ? undefined : posix.normalize(path);
}

function matchesTarget(path: string, requirement: NonNullable<RequestRequirements["fileOutput"]>): boolean {
  return requirement.path === undefined
    ? (requirement.format === "markdown" ? /\.(?:md|markdown)$/iu : /\.txt$/iu).test(path)
    : path === safePath(requirement.path);
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
