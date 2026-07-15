import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { Runtime } from "../runtime/create-runtime.js";
import { ToolActivityViewModelBuilder } from "./tool-activity-view-models.js";
import { renderPlain } from "../ui/renderers/plain-renderer.js";
import { toolDisplayIcon, toolDisplayLabel } from "../ui/tool-display.js";
import { formatPlainDelegationProgressEvent } from "../ui/papyrus/operator-console/activeWorkRuntimeMapper.js";

export type OneShotPromptResult = {
  handled: boolean;
  exitCode: number;
  output: string;
};

export type OneShotPromptOptions = {
  runtime: Runtime;
  argv: string[];
};

export async function runOneShotPrompt(options: OneShotPromptOptions): Promise<OneShotPromptResult> {
  const parsed = parseOneShotArgs(options.argv);

  if (parsed.prompt.length === 0) {
    return {
      handled: false,
      exitCode: 0,
      output: ""
    };
  }

  const activityBuilder = new ToolActivityViewModelBuilder({
    tools: options.runtime.tools()
  });
  const eventLines: string[] = [];
  const streamState = { lastWriteEndedWithNewline: true };
  const response = await options.runtime.handle({
    text: parsed.prompt,
    channel: "cli",
    onEvent: (event) => {
      const rendered = renderOneShotEvent(event, activityBuilder, streamState);

      if (rendered !== undefined) {
        eventLines.push(rendered);
      }
    }
  });
  try {
    options.runtime.enqueueSessionFinalization?.("one-shot");
  } catch {
    // A completed one-shot response should still return if durable queueing is unavailable.
  }

  return {
    handled: true,
    exitCode: 0,
    output: [
      ...eventLines,
      "",
      `${response.label}: ${response.text}`,
      response.providerExecution?.response === undefined
        ? undefined
        : `provider: ${response.providerExecution.response.provider}/${response.providerExecution.response.model}`,
      response.toolExecutions.length === 0
        ? undefined
        : `tools: ${response.toolExecutions.map((execution) => toolDisplayLabel(execution.tool.name)).join(", ")}`,
      response.progress.length === 0
        ? undefined
        : `progress: ${response.progress.join(" -> ")}`
    ].filter((line) => line !== undefined).join("\n")
  };
}

function parseOneShotArgs(argv: string[]): {
  prompt: string;
} {
  const promptParts: string[] = [];

  for (const arg of argv) {
    promptParts.push(arg);
  }

  return {
    prompt: promptParts.join(" ").trim(),
  };
}

function renderOneShotEvent(
  event: RuntimeEvent,
  activityBuilder: ToolActivityViewModelBuilder,
  streamState: { lastWriteEndedWithNewline: boolean }
): string | undefined {
  function safeLine(text: string): string {
    const endsWithNewline = text.endsWith("\n");
    const needsBoundary = !streamState.lastWriteEndedWithNewline && !text.startsWith("\n");
    streamState.lastWriteEndedWithNewline = endsWithNewline;
    return needsBoundary ? `\n${text}` : text;
  }

  switch (event.kind) {
    case "agent-start":
      return safeLine(`thinking: ${event.input}`);
    case "intent":
      return safeLine(`intent: ${event.labels.join(", ")} (${Math.round(event.confidence * 100)}%)`);
    case "skill":
      return safeLine(`skill: ${event.name}`);
    case "tool-start": {
      const vm = activityBuilder.buildTimelineEvent(event);
      return safeLine(renderPlain({ kind: "timeline", events: [vm] }));
    }
    case "tool-result": {
      const vm = activityBuilder.buildTimelineEvent(event);
      return safeLine(renderPlain({ kind: "timeline", events: [vm] }));
    }
    case "provider-attempt":
      return safeLine(event.fallback
        ? `provider fallback: ${event.provider}/${event.model}`
        : `provider: ${event.provider}/${event.model}`);
    case "provider-tool-call":
      return safeLine(`${toolDisplayIcon(event.name ?? "", "cli")} provider requested ${toolDisplayLabel(event.name ?? "provider-tool")}`);
    case "provider-result":
      return safeLine(event.ok
        ? `provider ready: ${event.provider}/${event.model}`
        : `provider issue: ${event.provider}/${event.model}${event.willFallback ? " (trying fallback)" : ""}`);
    case "provider-budget-exhausted":
      return safeLine(`provider budget: ${event.reason}`);
    case "context-usage":
      return undefined;
    case "delegation-progress": {
      const line = formatPlainDelegationProgressEvent(event);
      return line === undefined ? undefined : safeLine(line);
    }
    case "agent-cancelled":
      return safeLine(`cancelled: ${event.reason}`);
    case "provider-token": {
      streamState.lastWriteEndedWithNewline = event.text.endsWith("\n");
      return event.text;
    }
    case "agent-final":
      return undefined;
  }
}
