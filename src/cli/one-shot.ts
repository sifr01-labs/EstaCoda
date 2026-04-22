import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { Runtime } from "../runtime/create-runtime.js";

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

  if (parsed.trustWorkspace) {
    await options.runtime.trustWorkspace();
  }

  const eventLines: string[] = [];
  const response = await options.runtime.handle({
    text: parsed.prompt,
    channel: "cli",
    trustedWorkspace: parsed.trustWorkspace ? true : undefined,
    onEvent: (event) => {
      const rendered = renderOneShotEvent(event);

      if (rendered !== undefined) {
        eventLines.push(rendered);
      }
    }
  });

  return {
    handled: true,
    exitCode: 0,
    output: [
      parsed.trustWorkspace ? "Workspace trusted for this run." : undefined,
      ...eventLines,
      "",
      `${response.label}: ${response.text}`,
      response.providerExecution?.response === undefined
        ? undefined
        : `provider: ${response.providerExecution.response.provider}/${response.providerExecution.response.model}`,
      response.toolExecutions.length === 0
        ? undefined
        : `tools: ${response.toolExecutions.map((execution) => execution.tool.name).join(", ")}`,
      response.progress.length === 0
        ? undefined
        : `progress: ${response.progress.join(" -> ")}`
    ].filter((line) => line !== undefined).join("\n")
  };
}

function parseOneShotArgs(argv: string[]): {
  prompt: string;
  trustWorkspace: boolean;
} {
  const promptParts: string[] = [];
  let trustWorkspace = false;

  for (const arg of argv) {
    if (arg === "--trust" || arg === "--trusted") {
      trustWorkspace = true;
      continue;
    }

    if (arg === "--no-trust") {
      trustWorkspace = false;
      continue;
    }

    promptParts.push(arg);
  }

  return {
    prompt: promptParts.join(" ").trim(),
    trustWorkspace
  };
}

function renderOneShotEvent(event: RuntimeEvent): string | undefined {
  switch (event.kind) {
    case "agent-start":
      return `thinking: ${event.input}`;
    case "intent":
      return `intent: ${event.labels.join(", ")} (${Math.round(event.confidence * 100)}%)`;
    case "skill":
      return `skill: ${event.name}`;
    case "tool-start":
      return `tool: ${event.tool}`;
    case "tool-result":
      return `tool result: ${event.tool} ${event.ok === false ? "failed" : "ok"}`;
    case "provider-attempt":
      return event.fallback
        ? `provider fallback: ${event.provider}/${event.model}`
        : `provider: ${event.provider}/${event.model}`;
    case "provider-tool-call":
      return `provider tool call: ${event.name ?? "unknown"}`;
    case "provider-result":
      return event.ok
        ? `provider ready: ${event.provider}/${event.model}`
        : `provider issue: ${event.provider}/${event.model}${event.willFallback ? " (trying fallback)" : ""}`;
    case "provider-budget-exhausted":
      return `provider budget: ${event.reason}`;
    case "agent-cancelled":
      return `cancelled: ${event.reason}`;
    case "provider-token":
    case "agent-final":
      return undefined;
  }
}
