import { MAX_FILE_OUTPUTS, requestedFileOutputs } from "../contracts/request-requirements.js";
import { createHash } from "node:crypto";
import { readTaskResultEvidence } from "../tasks/task-result-read-evidence.js";
import { posix } from "node:path";
import type { ExecutionEvidenceRecord } from "../contracts/execution-plan.js";
import type { RequestRequirements } from "../contracts/intent.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";

export type FileOutputEvidence =
  | { satisfied: true; writeCallId?: string; path?: string; files?: Array<{ path: string; writeCallId: string }> }
  | { satisfied: false; path?: string; reason: "unresolved-target" | "missing-write" | "missing-readback" | "missing-research-result" | "report-content-mismatch" | "copy-source-mismatch" };

/** Reconciles executor-owned call identities with workspace-tool results from
 * this turn. Provider prose, artifact handles and unrelated tools cannot qualify. */
export function fileOutputEvidence(input: {
  requirements?: RequestRequirements;
  toolExecutions: readonly ToolExecutionRecord[];
  executionReceipts: readonly ExecutionEvidenceRecord[];
}): FileOutputEvidence {
  const requirements = requestedFileOutputs(input.requirements);
  if (requirements.length === 0) return { satisfied: true };
  if (requirements.length > MAX_FILE_OUTPUTS || input.requirements?.issues.length) return { satisfied: false, reason: "unresolved-target" };
  if (requirements.length <= 1) return singleFileOutputEvidence(input);
  if (requirements.some(file => file.path === undefined)) return { satisfied: false, reason: "unresolved-target" };
  const files: Array<{ path: string; writeCallId: string }> = [];
  for (const requirement of requirements) {
    const evidence = singleFileOutputEvidence({ ...input, requirements: {
      ...input.requirements!, fileOutput: requirement
    } });
    if (!evidence.satisfied) return { ...evidence, path: requirement.path };
    if (evidence.path === undefined || evidence.writeCallId === undefined) return { satisfied: false, reason: "unresolved-target" };
    files.push({ path: evidence.path, writeCallId: evidence.writeCallId });
  }
  return { satisfied: true, ...files[0], files };
}

/** Only existing, receipt-backed writes may enter read-only completion repair.
 * A denied file operation stays a boundary even if another operation succeeded. */
export function pendingFileReadbackPaths(input: Parameters<typeof fileOutputEvidence>[0]): string[] | undefined {
  const files = requestedFileOutputs(input.requirements);
  if (!files.length || files.length > MAX_FILE_OUTPUTS || input.requirements?.issues.length ||
      input.toolExecutions.some(call => call.decision !== "allow" && call.tool.name.startsWith("file."))) return undefined;
  const paths: string[] = [];
  for (const file of files) {
    if (file.path === undefined || safePath(file.path) !== file.path) return undefined;
    const evidence = singleFileOutputEvidence({ ...input, requirements: { ...input.requirements!, fileOutput: file } });
    if (evidence.satisfied) continue;
    if (evidence.reason !== "missing-readback") return undefined;
    paths.push(file.path);
  }
  return paths.length ? paths : undefined;
}

function singleFileOutputEvidence(input: Parameters<typeof fileOutputEvidence>[0]): FileOutputEvidence {
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
  let copyMismatch = false;
  const sourceReads = new Map<string, { digest: string; index: number }>();
  const writes = new Map<string, { digest: string; callId: string; index: number; sourcePath?: string }>();
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
          sourceReads.delete(target);
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
        let sourcePath: string | undefined;
        if (requirement.exactCopy !== undefined && (result === undefined || requirement.exactCopy.sourcePath !== undefined)) {
          const copied = metadata?.copiedSource;
          const copiedSource = copied !== null && typeof copied === "object" ? copied as Record<string, unknown> : undefined;
          sourcePath = safePath(requirement.exactCopy.sourcePath ?? copiedSource?.path);
          const sourceRead = sourcePath === undefined ? undefined : sourceReads.get(sourcePath);
          if (sourcePath === target || sourceRead === undefined || sourceRead.index >= recorded.index || sourceRead.digest !== contentSha256 ||
              (copiedSource !== undefined && (safePath(copiedSource.path) !== sourcePath || copiedSource.contentSha256 !== contentSha256))) {
            copyMismatch = true;
            continue;
          }
          copyMismatch = false;
        }
        writes.set(target, { digest: contentSha256, callId, index: recorded.index, sourcePath });
        verified.delete(target); // A later write invalidates an earlier readback.
      }
    }
    if (name !== "file.read" || metadata?.materialized !== true || (metadata.truncated === true && metadata.completeFileRead !== true) || !Number.isSafeInteger(metadata.bytes) || (metadata.bytes as number) < 0) continue;
    if (metadata.bytes === 0 && metadata.contentSha256 !== createHash("sha256").update("").digest("hex")) continue;
    const target = safePath(metadata.path);
    if (target !== undefined && validDigest(metadata.contentSha256)) sourceReads.set(target, { digest: metadata.contentSha256, index: recorded.index });
    const write = target === undefined ? undefined : writes.get(target);
    if (target !== undefined && write !== undefined && recorded.index > write.index && metadata.contentSha256 === write.digest) verified.set(target, write.callId);
  }
  for (const [path] of verified) {
    const write = writes.get(path)!;
    if (write.sourcePath !== undefined && sourceReads.get(write.sourcePath)?.digest !== write.digest) {
      verified.delete(path);
      copyMismatch = true;
    }
  }
  const verifiedFile = verified.entries().next().value as [string, string] | undefined;
  return verifiedFile === undefined
    ? { satisfied: false, reason: copyMismatch ? "copy-source-mismatch" : contentMismatch ? "report-content-mismatch" : writes.size === 0 ? "missing-write" : "missing-readback" }
    : { satisfied: true, path: verifiedFile[0], writeCallId: verifiedFile[1] };
}

/** General file edits use the same byte/readback contract as report delivery.
 * Pair each write only with receipts from its own turn, including save-only
 * follow-ups whose filename was established in earlier conversation context. */
export function verifiedFileMutationCallIds(input: Parameters<typeof fileOutputEvidence>[0]): Set<string> {
  const verified = new Set<string>();
  for (const receipt of input.executionReceipts) {
    if (receipt.status !== "success" || receipt.visibleTurnId === undefined || !["file.write", "file.patch"].includes(receipt.tool)) continue;
    const write = input.toolExecutions.find(call => call.toolCallId === receipt.toolCallId && call.tool.name === receipt.tool);
    const metadata = write?.result?.metadata;
    const outputs = Array.isArray(metadata?.fileOutputs) ? metadata.fileOutputs : [metadata];
    const paths = outputs.map(output => output !== null && typeof output === "object"
      ? safePath((output as Record<string, unknown>).path) : undefined);
    if (paths.length === 0 || paths.some(path => path === undefined)) continue;
    if (paths.every(path => {
      const outputRequirement = requestedFileOutputs(input.requirements).find(file => file.path === path);
      const bound = outputRequirement === undefined ? undefined : input.requirements;
      const evidence = fileOutputEvidence({ ...input, requirements: {
        ...bound, skillReferences: [], originTurnId: receipt.visibleTurnId,
        fileOutput: { ...outputRequirement, path: path!, format: "text" }, issues: bound?.issues ?? []
      } });
      return evidence.satisfied && evidence.writeCallId === receipt.toolCallId;
    })) verified.add(receipt.toolCallId);
  }
  return verified;
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

/** Returns only bytes bound to a successful write and subsequent complete
 * readback, concatenating all requested outputs for citation validation.
 * A file tool's prose or an unrelated earlier report is not evidence. */
export function verifiedFileOutputContent(input: Parameters<typeof fileOutputEvidence>[0]): string | undefined {
  const evidence = fileOutputEvidence(input);
  if (!evidence.satisfied || evidence.writeCallId === undefined) return undefined;
  const contents = (evidence.files ?? [evidence]).map(file => verifiedFileContent(input, file));
  return contents.some(content => content === undefined) ? undefined : contents.join("\n\n");
}

function verifiedFileContent(input: Parameters<typeof fileOutputEvidence>[0], evidence: { path?: string; writeCallId?: string }): string | undefined {
  const write = input.toolExecutions.find(execution => execution.toolCallId === evidence.writeCallId);
  if (write === undefined) return undefined;
  const metadata = write.result?.metadata;
  const outputs = Array.isArray(metadata?.fileOutputs) ? metadata.fileOutputs : [metadata];
  const output = outputs.find(value => value !== null && typeof value === "object" &&
    safePath((value as Record<string, unknown>).path) === evidence.path) as Record<string, unknown> | undefined;
  const digest = output?.contentSha256;
  const matches = (text: unknown): text is string => typeof text === "string" &&
    createHash("sha256").update(text).digest("hex") === digest;
  if (write.tool.name === "file.write" && matches(write.input?.content)) return write.input.content;
  // Patches and result exports may have no full content input. Only accept a
  // complete read body whose exact bytes match, stripping the tool's heading.
  for (const read of input.toolExecutions.slice(input.toolExecutions.indexOf(write) + 1)) {
    if (read.tool.name !== "file.read" || read.decision !== "allow" || read.result?.ok !== true ||
      read.result.metadata?.contentSha256 !== digest || read.result.metadata?.materialized !== true ||
      !input.executionReceipts.some(receipt => receipt.toolCallId === read.toolCallId && receipt.tool === "file.read" &&
        receipt.status === "success" && (input.requirements?.originTurnId === undefined || receipt.visibleTurnId === input.requirements.originTurnId))) continue;
    const content = read.result.content;
    const prefix = `# ${read.result.metadata.path}\n`;
    if (content.startsWith(prefix) && matches(content.slice(prefix.length))) return content.slice(prefix.length);
  }
  return undefined;
}
