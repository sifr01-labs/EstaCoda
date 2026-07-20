import type { ChannelKind } from "../contracts/channel.js";
import type { DelegateRole, DelegationConfig } from "../contracts/delegation.js";
import type { RuntimeEventSink } from "../contracts/runtime-event.js";
import type { SessionDB } from "../contracts/session.js";
import type { AgentLoopResponse } from "../runtime/agent-loop.js";
import type { ChildAgentLoopRuntime } from "../runtime/agent-loop-factory.js";
import type { SubagentRegistry } from "./subagent-registry.js";
import {
  type DelegationDiagnosticResult,
  writeDelegationDiagnostic
} from "./delegation-diagnostics.js";
import {
  createDelegationProgressRelay,
  type DelegationProgressSummary
} from "./progress-relay.js";

export type ChildRunnerInput = {
  child: ChildAgentLoopRuntime;
  childAbortController: AbortController;
  parentSignal?: AbortSignal;
  subagentRegistry: SubagentRegistry;
  subagentId: string;
  sessionDb: SessionDB;
  delegationConfig: DelegationConfig;
  diagnosticsRoot?: string;
  parentSessionId: string;
  childSessionId: string;
  role: DelegateRole;
  depth: number;
  task: string;
  context?: string;
  channel?: ChannelKind;
  trustedWorkspace: boolean;
  provider: string;
  model: string;
  effectiveAllowedTools: string[];
  taskIndex?: number;
  batchTaskCount?: number;
  batchId?: string;
  parentOnEvent?: RuntimeEventSink;
  prompt?: string;
  inputMetadata?: Record<string, unknown>;
  onHeartbeat?: () => void;
  now?: () => Date;
};

export type ChildRunnerResult =
  | {
      kind: "response";
      response: AgentLoopResponse;
      lastActivityAt: string;
    }
  | {
      kind: "timeout";
      summary: string;
      diagnostic?: DelegationDiagnosticResult;
      lastActivityAt: string;
    }
  | {
      kind: "cancelled";
      summary: string;
      lastActivityAt: string;
    };

export async function runDelegatedChild(input: ChildRunnerInput): Promise<ChildRunnerResult> {
  const state = createActivityState(input.now);
  const prompt = input.prompt ?? delegatedPrompt(input.task, input.context);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let heartbeatId: ReturnType<typeof setInterval> | undefined;
  let staleDiagnosticWritten = false;
  let timedOut = false;
  let cleanupRegistry = false;
  const pulse = (): boolean => {
    try {
      input.onHeartbeat?.();
      return true;
    } catch {
      if (!input.childAbortController.signal.aborted) {
        input.childAbortController.abort("child-heartbeat-failed");
      }
      return false;
    }
  };

  if (!pulse()) {
    return {
      kind: "cancelled",
      summary: "Child execution could not renew its owner heartbeat.",
      lastActivityAt: state.lastActivityAt
    };
  }

  const relay = createDelegationProgressRelay({
    metadata: {
      subagentId: input.subagentId,
      childSessionId: input.childSessionId,
      parentSessionId: input.parentSessionId,
      role: input.role,
      depth: input.depth,
      taskIndex: input.taskIndex,
      batchId: input.batchId,
      taskLabel: input.task,
      batchTaskCount: input.batchTaskCount ?? 1
    },
    parentOnEvent: input.parentOnEvent,
    onActivity: (_event, summary) => {
      state.record(summary);
      pulse();
      input.subagentRegistry.updateSubagent(input.subagentId, {
        lastActivityAt: state.lastActivityAt
      });
    }
  });

  const timeoutMs = Math.max(1, input.delegationConfig.childTimeoutSeconds * 1_000);
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeoutId = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  const heartbeatMs = Math.max(1, input.delegationConfig.heartbeatSeconds * 1_000);
  heartbeatId = setInterval(() => {
    void emitHeartbeat({
      input,
      state,
      pulse,
      staleDiagnosticWritten,
      markStaleDiagnosticWritten: () => {
        staleDiagnosticWritten = true;
      }
    }).catch(() => undefined);
  }, heartbeatMs);

  const childPromise = input.child.handle({
    text: prompt,
    channel: input.channel ?? "cli",
    trustedWorkspace: input.trustedWorkspace,
    signal: input.childAbortController.signal,
    onEvent: relay,
    inputMetadata: input.inputMetadata ?? {
      delegated: true,
      parentSessionId: input.parentSessionId
    }
  });
  childPromise.catch(() => undefined);

  try {
    const raced = await Promise.race([childPromise, timeoutPromise]);
    if (raced === "timeout") {
      timedOut = true;
      cleanupRegistry = true;
      input.subagentRegistry.updateSubagent(input.subagentId, {
        status: "timeout",
        lastActivityAt: state.lastActivityAt
      });
      if (!input.childAbortController.signal.aborted) {
        input.childAbortController.abort("child-timeout");
      }
      const diagnostic = await writeTimeoutDiagnostic(input, state, prompt, "timeout", timeoutMs);
      return {
        kind: "timeout",
        summary: `Delegated child timed out after ${input.delegationConfig.childTimeoutSeconds} seconds.`,
        diagnostic,
        lastActivityAt: state.lastActivityAt
      };
    }
    return {
      kind: "response",
      response: raced,
      lastActivityAt: state.lastActivityAt
    };
  } catch (error) {
    if (input.parentSignal?.aborted === true || input.childAbortController.signal.aborted) {
      cleanupRegistry = true;
      return {
        kind: "cancelled",
        summary: error instanceof Error ? error.message : "Delegated child cancelled.",
        lastActivityAt: state.lastActivityAt
      };
    }
    throw error;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    if (heartbeatId !== undefined) {
      clearInterval(heartbeatId);
    }
    if (!timedOut) {
      state.finish();
    }
    if (cleanupRegistry) {
      input.subagentRegistry.unregisterSubagent(input.subagentId);
    }
  }
}

type ActivityState = {
  readonly startedAt: string;
  lastActivityAt: string;
  inToolExecution: boolean;
  stale: boolean;
  completed: boolean;
  staleCycles: number;
  readonly summaries: string[];
  record(summary: DelegationProgressSummary): void;
  finish(): void;
};

function createActivityState(now: (() => Date) | undefined): ActivityState {
  const currentTime = () => (now?.() ?? new Date()).toISOString();
  const startedAt = currentTime();
  return {
    startedAt,
    lastActivityAt: startedAt,
    inToolExecution: false,
    stale: false,
    completed: false,
    staleCycles: 0,
    summaries: [],
    record(summary) {
      this.lastActivityAt = currentTime();
      this.inToolExecution = summary.inToolExecution;
      this.staleCycles = 0;
      this.summaries.push(summary.summary);
      if (this.summaries.length > 20) {
        this.summaries.splice(0, this.summaries.length - 20);
      }
    },
    finish() {
      this.completed = true;
      this.lastActivityAt = currentTime();
      this.inToolExecution = false;
    }
  };
}

async function emitHeartbeat(input: {
  input: ChildRunnerInput;
  state: ActivityState;
  pulse: () => boolean;
  staleDiagnosticWritten: boolean;
  markStaleDiagnosticWritten: () => void;
}): Promise<void> {
  if (input.state.completed) {
    return;
  }

  if (!input.pulse()) {
    return;
  }

  if (input.state.stale) {
    return;
  }

  input.state.staleCycles += 1;
  const staleLimit = input.state.inToolExecution
    ? input.input.delegationConfig.heartbeatStaleCyclesInTool
    : input.input.delegationConfig.heartbeatStaleCyclesIdle;
  if (input.state.staleCycles > staleLimit) {
    input.state.stale = true;
    if (!input.staleDiagnosticWritten) {
      input.markStaleDiagnosticWritten();
      const diagnostic = await writeTimeoutDiagnostic(input.input, input.state, undefined, "stale-heartbeat", undefined);
      if (diagnostic.path !== undefined) {
        await appendDiagnosticEvent(input.input, "stale-heartbeat", diagnostic);
      }
    }
    return;
  }

}

async function writeTimeoutDiagnostic(
  input: ChildRunnerInput,
  state: ActivityState,
  prompt: string | undefined,
  reason: "timeout" | "stale-heartbeat",
  timeoutDurationMs: number | undefined
): Promise<DelegationDiagnosticResult> {
  return await writeDelegationDiagnostic({
    diagnosticsRoot: input.diagnosticsRoot,
    config: input.delegationConfig.diagnostics,
    reason,
    parentSessionId: input.parentSessionId,
    childSessionId: input.childSessionId,
    task: input.task,
    prompt,
    role: input.role,
    depth: input.depth,
    effectiveTools: input.effectiveAllowedTools,
    provider: input.provider,
    model: input.model,
    lastActivityAt: state.lastActivityAt,
    lastSafeEventSummaries: state.summaries,
    timeoutDurationMs,
    taskIndex: input.taskIndex,
    batchId: input.batchId
  });
}

export async function appendDiagnosticEvent(
  input: Pick<ChildRunnerInput, "sessionDb" | "parentSessionId" | "childSessionId" | "role" | "depth" | "taskIndex" | "batchId">,
  reason: "timeout" | "stale-heartbeat",
  diagnostic: DelegationDiagnosticResult
): Promise<void> {
  if (diagnostic.path === undefined) {
    return;
  }
  await input.sessionDb.appendEvent(input.parentSessionId, {
    kind: "delegation-diagnostic",
    childSessionId: input.childSessionId,
    reason,
    diagnosticPath: diagnostic.path,
    taskHash: diagnostic.taskHash,
    taskPreview: diagnostic.taskPreview,
    role: input.role,
    depth: input.depth,
    taskIndex: input.taskIndex,
    batchId: input.batchId
  });
}

function delegatedPrompt(task: string, context: string | undefined): string {
  if (context === undefined || context.trim().length === 0) {
    return task;
  }
  return [
    `Delegated task: ${task}`,
    "",
    `Context: ${context}`
  ].join("\n");
}
