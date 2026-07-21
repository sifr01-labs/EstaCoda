import type { ResolvedAuxiliaryRoute, ResolvedModelRoute } from "../contracts/provider.js";
import { executeAuxiliaryTask } from "../providers/auxiliary-executor.js";
import type { ProviderExecutor } from "../providers/provider-executor.js";

export interface SnapshotSummarizerOptions {
  providerExecutor?: Pick<ProviderExecutor, "complete">;
  auxiliaryRoute?: ResolvedAuxiliaryRoute;
  mainRoute?: ResolvedModelRoute;
  maxResultSizeChars: number;
  threshold: number;
  mode: boolean | "auto";
  redact?: (value: string) => string;
  debug?: {
    log?: (event: string, metadata?: Record<string, unknown>) => void;
  };
}

export interface SnapshotSummarizeInput {
  renderedSnapshot: string;
  userTask?: string;
  signal?: AbortSignal;
  executionSessionId?: string;
  visibleTurnId?: string;
}

export interface SnapshotSummarizeResult {
  content: string;
  summarized: boolean;
  reason?: string;
}

const DEFAULT_SUMMARY_MAX_TOKENS = 4_000;
const SUMMARY_TEMPERATURE = 0.1;
const TRUNCATION_SUFFIX = "\n... [truncated]";

export async function maybeSummarizeSnapshot(
  input: SnapshotSummarizeInput,
  options: SnapshotSummarizerOptions
): Promise<SnapshotSummarizeResult> {
  const renderedSnapshot = input.renderedSnapshot;
  if (renderedSnapshot.length <= options.threshold) {
    options.debug?.log?.("browser.snapshot.summarize.skipped", {
      reason: "below-threshold",
      chars: renderedSnapshot.length,
      threshold: options.threshold
    });
    return {
      content: truncateSnapshotText(renderedSnapshot, options.maxResultSizeChars),
      summarized: false,
      reason: "below-threshold"
    };
  }

  if (options.mode === false) {
    options.debug?.log?.("browser.snapshot.summarize.skipped", {
      reason: "disabled",
      chars: renderedSnapshot.length,
      threshold: options.threshold
    });
    return {
      content: truncateSnapshotText(renderedSnapshot, options.maxResultSizeChars),
      summarized: false,
      reason: "disabled"
    };
  }

  const route = options.auxiliaryRoute;
  const providerExecutor = options.providerExecutor;
  if (route?.route === undefined || providerExecutor === undefined) {
    const reason = providerExecutor === undefined ? "missing-provider-executor" : "missing-auxiliary-route";
    options.debug?.log?.("browser.snapshot.summarize.skipped", {
      reason,
      mode: options.mode,
      chars: renderedSnapshot.length,
      threshold: options.threshold
    });
    return {
      content: truncateSnapshotText(renderedSnapshot, options.maxResultSizeChars),
      summarized: false,
      reason
    };
  }

  const redact = options.redact ?? redactSnapshotSecrets;
  const redactedSnapshot = redact(renderedSnapshot);
  options.debug?.log?.("browser.snapshot.summarize.attempted", {
    chars: renderedSnapshot.length,
    redactedChars: redactedSnapshot.length,
    threshold: options.threshold,
    provider: route.route.provider,
    model: route.route.id
  });

  try {
    const result = await executeAuxiliaryTask({
      route,
      mainRoute: options.mainRoute ?? route.route,
      providerExecutor,
      usage: {
        ...(input.executionSessionId === undefined ? {} : {
          executionSessionId: input.executionSessionId,
          sessionBudgetScopeId: input.executionSessionId
        }),
        ...(input.visibleTurnId === undefined ? {} : { visibleTurnId: input.visibleTurnId })
      },
      request: {
        model: route.route.id,
        messages: [
          {
            role: "system",
            content: [
              "You summarize EstaCoda browser snapshots for an agent.",
              "Preserve all useful interactive elements and their exact @eN refs.",
              "Preserve headings, labels, buttons, links, input names, values, checked/disabled states, warnings, and page context.",
              "Do not invent refs or browser state. Stay concise and task-relevant."
            ].join(" ")
          },
          {
            role: "user",
            content: [
              input.userTask?.trim()
                ? `User task:\n${redact(input.userTask.trim())}`
                : "User task: not provided. Summarize generally while keeping important interactive refs.",
              "",
              "Rendered browser snapshot:",
              redactedSnapshot
            ].join("\n")
          }
        ],
        temperature: SUMMARY_TEMPERATURE,
        maxTokens: DEFAULT_SUMMARY_MAX_TOKENS
      },
      signal: input.signal,
      scopeKey: "browser.snapshot"
    });

    const rawContent = result.response?.content?.trim();
    if (!result.ok || rawContent === undefined || rawContent.length === 0) {
      const reason = result.status === "ok" ? "empty-summary" : result.status;
      options.debug?.log?.("browser.snapshot.summarize.failed", {
        reason,
        attempts: result.attempts.map((attempt) => ({
          provider: attempt.provider,
          model: attempt.model,
          ok: attempt.ok,
          errorClass: attempt.errorClass
        }))
      });
      return {
        content: truncateSnapshotText(renderedSnapshot, options.maxResultSizeChars),
        summarized: false,
        reason
      };
    }

    const content = truncateSnapshotText(redact(rawContent), options.maxResultSizeChars);
    options.debug?.log?.("browser.snapshot.summarize.succeeded", {
      chars: renderedSnapshot.length,
      summaryChars: content.length,
      provider: result.response?.provider,
      model: result.response?.model
    });
    return {
      content,
      summarized: true
    };
  } catch (error) {
    options.debug?.log?.("browser.snapshot.summarize.failed", {
      reason: "exception",
      message: error instanceof Error ? error.message : "Snapshot summarization failed"
    });
    return {
      content: truncateSnapshotText(renderedSnapshot, options.maxResultSizeChars),
      summarized: false,
      reason: "exception"
    };
  }
}

export function redactSnapshotSecrets(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>\\)]+/giu, (url) => redactUrlCredentials(url))
    .replace(/\bBearer\s+[\w.\-~+/]+=*/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk-ant-|sk-|ghp_)[A-Za-z0-9_\-]+/gu, "[REDACTED_SECRET]")
    .replace(/\b(token|api_key|password)=([^&\s]+)/giu, "$1=[REDACTED]");
}

export function truncateSnapshotText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - TRUNCATION_SUFFIX.length))}${TRUNCATION_SUFFIX}`;
}

function redactUrlCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username.length > 0 || parsed.password.length > 0) {
      parsed.username = "[REDACTED]";
      parsed.password = "";
    }
    return parsed.toString();
  } catch {
    return url.replace(/^(https?:\/\/)[^/\s:@]+:[^/\s@]+@/iu, "$1[REDACTED]@");
  }
}
