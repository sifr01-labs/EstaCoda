import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { TaskAttemptActivity } from "./task-step-executor.js";

type DelegationProgressEvent = Extract<RuntimeEvent, { kind: "delegation-progress" }>;

/** Converts already-sanitized child progress into a small persistence-safe Task checkpoint. */
export function taskActivityFromDelegationProgress(event: DelegationProgressEvent): TaskAttemptActivity | undefined {
  const child = event.childEvent;
  switch (child.kind) {
    case "agent-start":
      return { kind: "worker", label: "Worker started" };
    case "tool-start":
      return {
        kind: "tool",
        label: `Using ${safeToolName(child.tool)}`,
        toolCategory: taskToolCategory(child.tool),
      };
    case "tool-result":
      return {
        kind: "tool",
        label: `${safeToolName(child.tool)} ${child.ok === false ? "failed" : "finished"}`,
        toolCategory: taskToolCategory(child.tool),
      };
    case "provider-attempt":
      return { kind: "provider", label: child.fallback === true ? "Trying fallback provider" : "Waiting for provider" };
    case "provider-result":
      return child.willFallback === true
        ? { kind: "provider", label: "Provider route failed; switching fallback" }
        : { kind: "provider", label: child.ok === false ? "Provider failed" : "Provider finished" };
    case "provider-budget-exhausted":
      return { kind: "provider", label: "Provider budget exhausted" };
    case "agent-final":
      return { kind: "worker", label: "Worker finished" };
    case "agent-cancelled":
      return { kind: "worker", label: "Worker cancelled" };
    case "delegation-result":
      return { kind: "worker", label: `Worker ${child.status ?? "settled"}` };
  }
}

export function taskToolCategory(toolName: string | undefined): string {
  const namespace = toolName?.split(/[._-]/u, 1)[0]?.toLowerCase();
  switch (namespace) {
    case "file": return "files";
    case "terminal":
    case "process":
    case "execute": return "process";
    case "web": return "web";
    case "browser": return "browser";
    case "media":
    case "vision": return "media";
    case "voice": return "voice";
    case "image": return "image";
    case "config":
    case "workspace": return "configuration";
    case "memory":
    case "knowledge": return "memory";
    case "skill": return "skills";
    case "delegate": return "delegation";
    default: return "tool";
  }
}

function safeToolName(toolName: string | undefined): string {
  if (toolName === undefined || !/^[a-zA-Z0-9._-]{1,160}$/u.test(toolName)) return "tool";
  return toolName;
}
