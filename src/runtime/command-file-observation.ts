import { posix } from "node:path";
import { MAX_FILE_OUTPUTS } from "../contracts/request-requirements.js";
import type { CommandFileObservation } from "../execution/command-file-evidence.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";

export function safePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 240 || value.length === 0 || /^(?:[/\\]|[a-z]:)/iu.test(value)) return undefined;
  const path = value.replaceAll("\\", "/");
  return path.split("/").includes("..") ? undefined : posix.normalize(path);
}

export function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

/** Only known runtime-owned command observations qualify, bound to the turn
 * that started the command. Arbitrary tools and provider metadata cannot write. */
export function commandFileChanges(execution: ToolExecutionRecord, visibleTurnId?: string): Array<{ path: string; contentSha256?: string; metadataFingerprint?: string }> {
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

export function validMetadataFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^metadata:[a-f0-9]{64}$/u.test(value);
}
