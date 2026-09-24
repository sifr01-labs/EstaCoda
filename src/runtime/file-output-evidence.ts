import { posix } from "node:path";
import type { ExecutionEvidenceRecord } from "../contracts/execution-plan.js";
import type { RequestRequirements } from "../contracts/intent.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";

export type FileOutputEvidence =
  | { satisfied: true; writeCallId?: string }
  | { satisfied: false; reason: "unresolved-target" | "missing-write" | "missing-readback" };

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
        writes.set(target, { digest: contentSha256, callId, index: recorded.index });
        verified.delete(target); // A later write invalidates an earlier readback.
      }
    }
    if (name !== "file.read" || metadata?.materialized !== true || metadata.truncated === true || typeof metadata.bytes !== "number" || metadata.bytes <= 0) continue;
    const target = safePath(metadata.path);
    const write = target === undefined ? undefined : writes.get(target);
    if (target !== undefined && write !== undefined && recorded.index > write.index && metadata.contentSha256 === write.digest) verified.set(target, write.callId);
  }
  const writeCallId = verified.values().next().value as string | undefined;
  return writeCallId === undefined
    ? { satisfied: false, reason: writes.size === 0 ? "missing-write" : "missing-readback" }
    : { satisfied: true, writeCallId };
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
