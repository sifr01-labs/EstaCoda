import { MAX_FILE_OUTPUTS, matchesFileOutputPath, requestedFileOutputs, requiresFileContentVerification, validateRequestRequirements } from "../contracts/request-requirements.js";
import type { CommandFileObservation } from "../execution/command-file-evidence.js";
import { createHash } from "node:crypto";
import { readTaskResultEvidence } from "../tasks/task-result-read-evidence.js";
import { posix } from "node:path";
import type { ExecutionEvidenceRecord } from "../contracts/execution-plan.js";
import type { RequestRequirements } from "../contracts/intent.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";

export type FileOutputEvidence =
  | { satisfied: true; contentVerified?: boolean; writeCallId?: string; path?: string; files?: Array<{ path: string; writeCallId: string }> }
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
  try { validateRequestRequirements(input.requirements); } catch { return { satisfied: false, reason: "unresolved-target" }; }
  if (requirements.length > MAX_FILE_OUTPUTS || input.requirements?.issues.length) return { satisfied: false, reason: "unresolved-target" };
  if (requirements.length <= 1) return singleFileOutputEvidence(input);
  if (requirements.some(file => file.path === undefined)) return { satisfied: false, reason: "unresolved-target" };
  const files: Array<{ path: string; writeCallId: string }> = [];
  let contentVerified = true;
  for (const requirement of requirements) {
    const evidence = singleFileOutputEvidence({ ...input, requirements: {
      ...input.requirements!, fileOutput: requirement
    } });
    if (!evidence.satisfied) return { ...evidence, path: evidence.path ?? requirement.path };
    if (evidence.path === undefined || evidence.writeCallId === undefined) return { satisfied: false, reason: "unresolved-target" };
    if (files.some(file => file.path === evidence.path)) return { satisfied: false, reason: "unresolved-target" };
    contentVerified &&= evidence.contentVerified === true;
    files.push({ path: evidence.path, writeCallId: evidence.writeCallId });
  }
  return { satisfied: true, contentVerified, ...files[0], files };
}

/** Only existing, receipt-backed writes may enter read-only completion repair.
 * A denied file operation stays a boundary even if another operation succeeded. */
export function pendingFileReadbackPaths(input: Parameters<typeof fileOutputEvidence>[0]): string[] | undefined {
  const files = requestedFileOutputs(input.requirements);
  if (!files.length || files.length > MAX_FILE_OUTPUTS || input.requirements?.issues.length ||
      input.toolExecutions.some(call => call.decision !== "allow" && call.tool.name.startsWith("file."))) return undefined;
  try { validateRequestRequirements(input.requirements); } catch { return undefined; }
  const paths: string[] = [];
  for (const file of files) {
    if (file.path === undefined || safePath(file.path) !== file.path) return undefined;
    const evidence = singleFileOutputEvidence({ ...input, requirements: { ...input.requirements!, fileOutput: file } });
    if (evidence.satisfied) continue;
    if (evidence.reason !== "missing-readback") return undefined;
    paths.push(evidence.path ?? file.path);
  }
  return paths.length ? paths : undefined;
}

function singleFileOutputEvidence(input: Parameters<typeof fileOutputEvidence>[0]): FileOutputEvidence {
  const requirement = input.requirements?.fileOutput;
  if (!requirement?.alternativePaths?.length) return concreteFileOutputEvidence(input);
  let pending: FileOutputEvidence | undefined;
  let failure: FileOutputEvidence | undefined;
  for (const path of [requirement.path, ...requirement.alternativePaths]) {
    const evidence = concreteFileOutputEvidence({ ...input, requirements: { ...input.requirements!, fileOutput: { ...requirement, path, alternativePaths: undefined } } });
    if (evidence.satisfied) return evidence;
    failure ??= evidence;
    if (evidence.reason === "missing-readback") pending = { ...evidence, path: evidence.path ?? path };
  }
  return pending ?? failure ?? { satisfied: false, reason: "unresolved-target" };
}

function concreteFileOutputEvidence(input: Parameters<typeof fileOutputEvidence>[0]): FileOutputEvidence {
  const requirement = input.requirements?.fileOutput;
  if (requirement === undefined) return { satisfied: true };
  if (input.requirements?.issues.some((issue) => issue === "ambiguous-file-target" || issue === "unsafe-file-target")) {
    return { satisfied: false, reason: "unresolved-target" };
  }
  if (!requiresFileContentVerification(input.requirements, requirement)) return producedFileEvidence(input);
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
  const observedCommands = new Set<string>();
  for (const execution of input.toolExecutions) {
    const callId = execution.toolCallId;
    const recorded = callId === undefined ? undefined : receipts.get(callId);
    if (callId === undefined || recorded === undefined || recorded.receipt.tool !== execution.tool.name) continue;
    const metadata = execution.result?.metadata;
    const name = execution.tool.name;
    const observation = metadata?.commandFileObservation as { id?: string; completed?: boolean } | undefined;
    const repeatedCommand = typeof observation?.id === "string" && observedCommands.has(observation.id);
    const command = repeatedCommand ? [] : commandFileChanges(execution, recorded.receipt.visibleTurnId);
    if (command.length && observation?.completed === true && typeof observation.id === "string") observedCommands.add(observation.id);
    // A later command may remove/replace an already verified destination, even
    // if it fails. Unfinished or unreadable observations cannot preserve proof.
    for (const output of command) {
      // A service snapshot may observe our own intervening write. Matching bytes
      // preserve its evidence; the snapshot never creates new production proof.
      if (commandFileObservation(execution, recorded.receipt.visibleTurnId)?.serviceCheckpoint &&
          output.contentSha256 !== undefined && writes.get(output.path)?.digest === output.contentSha256) continue;
      verified.delete(output.path);
      writes.delete(output.path);
      sourceReads.delete(output.path);
    }
    const touched = Array.isArray(metadata?.paths) ? metadata.paths : [metadata?.path ?? execution.input?.path];
    if (name === "file.read" || name === "file.write" || name === "file.patch") {
      for (const path of touched) {
        const target = safePath(path);
        if (target !== undefined) {
          // Reading unchanged bytes cannot undo earlier full verification. A
          // changed digest or a failed observation still invalidates that proof.
          const observedDigest = metadata?.observedContentSha256 ?? metadata?.contentSha256;
          const unchangedRead = name === "file.read" && recorded.receipt.status === "success" &&
            execution.decision === "allow" && execution.result?.ok === true && metadata?.materialized === true && validDigest(observedDigest) &&
            (writes.get(target)?.digest ?? sourceReads.get(target)?.digest) === observedDigest;
          if (!unchangedRead) {
            verified.delete(target);
            sourceReads.delete(target);
          }
          if (name !== "file.read") writes.delete(target);
        }
      }
    }
    if (recorded.receipt.status !== "success" || execution.decision !== "allow" || execution.result?.ok !== true) continue;
    if (name === "file.write" || name === "file.patch" || commandCompleted(execution)) {
      const outputs = name === "file.write" || name === "file.patch"
        ? Array.isArray(metadata?.fileOutputs) ? metadata.fileOutputs : [metadata]
        : command;
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
  if (requirement.directoryUnspecified && writes.size > 1) return { satisfied: false, reason: "unresolved-target" };
  const verifiedFile = verified.entries().next().value as [string, string] | undefined;
  return verifiedFile === undefined
    ? { satisfied: false, ...(requirement.directoryUnspecified && writes.size === 1 ? { path: writes.keys().next().value! } : {}), reason: copyMismatch ? "copy-source-mismatch" : contentMismatch ? "report-content-mismatch" : writes.size === 0 ? "missing-write" : "missing-readback" }
    : { satisfied: true, contentVerified: true, path: verifiedFile[0], writeCallId: verifiedFile[1] };
}

/** Production evidence is deliberately weaker than content verification. A
 * successful command alone is insufficient: the runtime must observe the named
 * output change. Missing, pending, failed and later-invalidated outputs fail. */
function producedFileEvidence(input: Parameters<typeof fileOutputEvidence>[0]): FileOutputEvidence {
  const requirement = input.requirements!.fileOutput!;
  const receipts = new Map(input.executionReceipts.filter(receipt =>
    input.requirements?.originTurnId === undefined || receipt.visibleTurnId === input.requirements.originTurnId
  ).map(receipt => [receipt.toolCallId, receipt]));
  const produced = new Map<string, { callId: string; digest?: string }>();
  const seen = new Set<string>();
  const pending = new Map<string, string[]>();
  for (const execution of input.toolExecutions) {
    const callId = execution.toolCallId;
    const receipt = callId === undefined ? undefined : receipts.get(callId);
    if (!callId || !receipt || receipt.tool !== execution.tool.name) continue;
    const metadata = execution.result?.metadata;
    const observation = commandFileObservation(execution, receipt.visibleTurnId);
    const repeated = observation !== undefined && seen.has(observation.id);
    if (observation && !repeated) {
      if (observation.completed) pending.delete(observation.id);
      else pending.set(observation.id, observation.files.map(file => file.path));
    }
    // A running validation command temporarily blocks completion. If it exits
    // without changing the file, the earlier production evidence remains valid.
    const changes = !observation?.completed || repeated ? [] : commandFileChanges(execution, receipt.visibleTurnId);
    if (observation?.completed) seen.add(observation.id);
    for (const change of changes) {
      if (observation?.serviceCheckpoint && change.contentSha256 !== undefined && produced.get(change.path)?.digest === change.contentSha256) continue;
      produced.delete(change.path);
    }
    const fileTool = ["file.write", "file.patch"].includes(execution.tool.name);
    const outputs = fileTool ? Array.isArray(metadata?.fileOutputs) ? metadata.fileOutputs : [metadata] : changes;
    if (fileTool) {
      const touched = Array.isArray(metadata?.paths) ? metadata.paths : [metadata?.path ?? execution.input?.path];
      for (const value of touched) {
        const path = safePath(value);
        if (path) produced.delete(path);
      }
    }
    if (receipt.status !== "success" || execution.decision !== "allow" || execution.result?.ok !== true || (!fileTool && !commandCompleted(execution))) continue;
    for (const output of outputs) {
      if (!output || typeof output !== "object") continue;
      const item = output as Record<string, unknown>;
      const path = safePath(item.path);
      if (!path || !matchesTarget(path, requirement)) continue;
      if (fileTool ? (item.materialized ?? metadata?.materialized) !== true || !validDigest(item.contentSha256) : !validDigest(item.contentSha256) && !validMetadataFingerprint(item.metadataFingerprint)) continue;
      produced.set(path, { callId, digest: validDigest(item.contentSha256) ? item.contentSha256 : undefined });
    }
  }
  for (const paths of pending.values()) for (const path of paths) produced.delete(path);
  if (requirement.directoryUnspecified && produced.size > 1) return { satisfied: false, reason: "unresolved-target" };
  const found = produced.entries().next().value;
  return found ? { satisfied: true, contentVerified: false, path: found[0], writeCallId: found[1].callId }
    : { satisfied: false, path: requirement.path, reason: "missing-write" };
}

/** Label a file edit verified only under the byte/readback contract; ordinary
 * production evidence alone never upgrades its verification status.
 * Pair each write only with receipts from its own turn, including save-only
 * follow-ups whose filename was established in earlier conversation context. */
export function verifiedFileMutationCallIds(input: Parameters<typeof fileOutputEvidence>[0]): Set<string> {
  const verified = new Set<string>();
  for (const receipt of input.executionReceipts) {
    if (receipt.status !== "success" || receipt.visibleTurnId === undefined || !["file.write", "file.patch", "terminal.run", "execute_code", "process.logs"].includes(receipt.tool)) continue;
    const write = input.toolExecutions.find(call => call.toolCallId === receipt.toolCallId && call.tool.name === receipt.tool);
    const metadata = write?.result?.metadata;
    const outputs = write && commandCompleted(write) ? commandFileChanges(write, receipt.visibleTurnId) : Array.isArray(metadata?.fileOutputs) ? metadata.fileOutputs : [metadata];
    const paths = outputs.map(output => output !== null && typeof output === "object"
      ? safePath((output as Record<string, unknown>).path) : undefined);
    if (paths.length === 0 || paths.some(path => path === undefined)) continue;
    if (paths.every(path => {
      const outputRequirement = requestedFileOutputs(input.requirements).find(file => matchesFileOutputPath(path!, file));
      const bound = outputRequirement === undefined ? undefined : input.requirements;
      const evidence = fileOutputEvidence({ ...input, requirements: {
        ...bound, skillReferences: [], originTurnId: receipt.visibleTurnId,
        fileOutput: { ...outputRequirement, verification: undefined, directoryUnspecified: undefined, alternativePaths: undefined, path: path!, format: "text" }, issues: bound?.issues ?? []
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
    : matchesFileOutputPath(path, requirement);
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

/** Returns only bytes bound to a successful write and subsequent complete
 * readback, concatenating all requested outputs for citation validation.
 * A file tool's prose or an unrelated earlier report is not evidence. */
export function verifiedFileOutputContent(input: Parameters<typeof fileOutputEvidence>[0]): string | undefined {
  const evidence = fileOutputEvidence(input);
  if (!evidence.satisfied || evidence.contentVerified !== true || evidence.writeCallId === undefined) return undefined;
  const contents = (evidence.files ?? [evidence]).map(file => verifiedFileContent(input, file));
  return contents.some(content => content === undefined) ? undefined : contents.join("\n\n");
}

function verifiedFileContent(input: Parameters<typeof fileOutputEvidence>[0], evidence: { path?: string; writeCallId?: string }): string | undefined {
  const write = input.toolExecutions.find(execution => execution.toolCallId === evidence.writeCallId);
  if (write === undefined) return undefined;
  const metadata = write.result?.metadata;
  const receipt = input.executionReceipts.find(receipt => receipt.toolCallId === write.toolCallId);
  const outputs = commandCompleted(write) ? commandFileChanges(write, receipt?.visibleTurnId) : Array.isArray(metadata?.fileOutputs) ? metadata.fileOutputs : [metadata];
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

/** Only known runtime-owned command observations qualify, bound to the turn
 * that started the command. Arbitrary tools and provider metadata cannot write. */
function commandFileChanges(execution: ToolExecutionRecord, visibleTurnId?: string): Array<{ path: string; contentSha256?: string; metadataFingerprint?: string }> {
  const observation = commandFileObservation(execution, visibleTurnId);
  return observation?.files.flatMap(({ path, before, after, metadataOnly }) => {
    const valid = metadataOnly === true ? validMetadataFingerprint : validDigest;
    if (before === after && after !== undefined) return [];
    return [{ path, ...(observation.completed && valid(after)
      ? metadataOnly === true ? { metadataFingerprint: after as string } : { contentSha256: after as string } : {}) }];
  }) ?? [];
}

export function commandFileObservation(execution: ToolExecutionRecord, visibleTurnId?: string): CommandFileObservation | undefined {
  if (!["terminal.run", "execute_code", "process.start", "process.logs"].includes(execution.tool.name)) return undefined;
  const value = execution.result?.metadata?.commandFileObservation;
  if (!value || typeof value !== "object") return undefined;
  const observation = value as Record<string, unknown>;
  if (typeof observation.id !== "string" || !/^[a-f0-9-]{36}$/u.test(observation.id) || typeof observation.completed !== "boolean") return undefined;
  if (!visibleTurnId || observation.originTurnId !== visibleTurnId || !Array.isArray(observation.files) || observation.files.length > MAX_FILE_OUTPUTS) return undefined;
  const files = observation.files.flatMap(value => {
    if (!value || typeof value !== "object") return [];
    const { path, before, after, metadataOnly } = value as CommandFileObservation["files"][number];
    const target = safePath(path);
    const valid = metadataOnly === true ? validMetadataFingerprint : validDigest;
    return !target || (before !== null && before !== undefined && !valid(before)) ? [] : [{ path: target, before, after, metadataOnly }];
  });
  return { id: observation.id, completed: observation.completed, originTurnId: visibleTurnId, files,
    ...(observation.serviceCheckpoint === true && ["process.start", "process.logs"].includes(execution.tool.name) &&
      (execution.result?.metadata?.process as { purpose?: unknown } | undefined)?.purpose === "service" ? { serviceCheckpoint: true as const } : {}) };
}

function validMetadataFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^metadata:[a-f0-9]{64}$/u.test(value);
}

function commandCompleted(execution: ToolExecutionRecord): boolean {
  const metadata = execution.result?.metadata;
  if (execution.tool.name === "terminal.run") return metadata?.code === 0 && metadata.signal === null && metadata.timedOut === false && metadata.cancelled === false && metadata.running !== true;
  if (execution.tool.name === "execute_code") return metadata?.exitCode === 0 && metadata.signal === null && metadata.timedOut !== true && metadata.cancelled !== true;
  if (execution.tool.name !== "process.logs" || !metadata?.process || typeof metadata.process !== "object") return false;
  const process = metadata.process as Record<string, unknown>;
  return process.status === "exited" && process.exitCode === 0 && process.signal == null;
}
