import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { TaskAttemptActivity, TaskTraceCategory } from "./task-step-executor.js";

type DelegationProgressEvent = Extract<RuntimeEvent, { kind: "delegation-progress" }>;

/** Converts already-sanitized child progress into a small persistence-safe Task checkpoint. */
export function taskActivityFromDelegationProgress(event: DelegationProgressEvent): TaskAttemptActivity | undefined {
  const child = event.childEvent;
  switch (child.kind) {
    case "agent-start":
      return { kind: "worker", label: "Starting delegated work", traceCategory: "plan" };
    case "tool-start": {
      const traceCategory = taskTraceCategoryFromTool(child.tool);
      const toolCategory = taskToolCategory(child.tool);
      return {
        kind: "tool",
        label: toolActivityLabel(traceCategory, toolCategory, false),
        traceCategory,
        toolCategory,
      };
    }
    case "tool-result": {
      const traceCategory = child.ok === false ? "failed" : taskTraceCategoryFromTool(child.tool);
      const toolCategory = taskToolCategory(child.tool);
      return {
        kind: "tool",
        label: child.ok === false ? "Activity failed" : toolActivityLabel(traceCategory, toolCategory, true),
        traceCategory,
        toolCategory,
      };
    }
    case "provider-attempt":
      return {
        kind: "provider",
        label: child.fallback === true ? "Trying fallback provider" : "Planning next action",
        traceCategory: "plan"
      };
    case "provider-result":
      return child.willFallback === true
        ? { kind: "provider", label: "Provider route failed; switching fallback", traceCategory: "plan" }
        : {
            kind: "provider",
            label: child.ok === false ? "Provider failed" : "Plan updated",
            traceCategory: child.ok === false ? "failed" : "plan"
          };
    case "provider-budget-exhausted":
      return { kind: "provider", label: "Provider budget exhausted", traceCategory: "failed" };
    case "assistant-preview":
      if (child.preview === undefined) return undefined;
      return {
        kind: "assistant",
        label: "Assistant answer",
        traceCategory: "answer",
        assistantPreview: child.preview
      };
    case "agent-final":
      return { kind: "worker", label: "Result ready", traceCategory: "finish" };
    case "agent-cancelled":
      return { kind: "worker", label: "Worker cancelled", traceCategory: "failed" };
    case "delegation-result":
      return {
        kind: "worker",
        label: child.status === "completed" ? "Result ready" : `Delegated work ${child.status ?? "settled"}`,
        traceCategory: child.status === "completed"
          ? "finish"
          : child.status === "blocked"
            ? "wait"
            : "failed"
      };
  }
}

/** Maps implementation-specific tool names to the stable trace vocabulary. */
export function taskTraceCategoryFromTool(toolName: string | undefined): TaskTraceCategory {
  const normalized = toolName?.toLowerCase() ?? "";
  if (/(?:^|[._-])(rg|ripgrep|grep|search|find|glob)(?:$|[._-])/u.test(normalized)) return "search";
  if (/(?:^|[._-])(write|edit|patch|replace|delete|remove|move|copy|mkdir)(?:$|[._-])/u.test(normalized)) return "edit";
  if (/(?:^|[._-])(read|open|view|fetch|get|list|stat|inspect)(?:$|[._-])/u.test(normalized)) return "read";
  if (/(?:^|[._-])(terminal|process|execute|shell|command|run)(?:$|[._-])/u.test(normalized)) return "terminal";
  return "plan";
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

function toolActivityLabel(category: TaskTraceCategory, toolCategory: string, finished: boolean): string {
  switch (category) {
    case "terminal": return finished ? "Command completed" : "Running command";
    case "search": return finished ? "Search completed" : "Searching";
    case "read": {
      if (toolCategory === "memory" || toolCategory === "configuration") {
        return finished ? `${capitalize(toolCategory)} inspected` : `Inspecting ${toolCategory}`;
      }
      if (toolCategory === "web" || toolCategory === "browser") {
        return finished ? "Sources reviewed" : "Reviewing sources";
      }
      return finished ? "Files reviewed" : "Reading files";
    }
    case "edit": return finished ? "Changes written" : "Writing changes";
    default:
      if (toolCategory === "web" || toolCategory === "browser") {
        return finished ? "Sources reviewed" : "Reviewing sources";
      }
      return finished ? "Inspection completed" : "Inspecting task context";
  }
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
