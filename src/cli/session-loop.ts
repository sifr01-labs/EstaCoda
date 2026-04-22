import { createInterface, type Interface } from "node:readline/promises";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import type { Runtime } from "../runtime/create-runtime.js";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import { renderSlashMenu, renderToolsMenu, SESSION_COMMANDS } from "./slash-menu.js";
import { ToolActivityRenderer } from "./tool-activity-renderer.js";

export type SessionLoopOptions = {
  runtime: Runtime;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  prompt?: (question: string) => Promise<string>;
  close?: () => void;
};

export async function runSessionLoop(options: SessionLoopOptions): Promise<void> {
  const output = options.output ?? defaultOutput;
  const activityRenderer = new ToolActivityRenderer({
    tools: options.runtime.tools()
  });
  let readline: Interface | undefined;
  let activeTurn: AbortController | undefined;
  const prompt = options.prompt ?? (() => {
    readline = createInterface({
      input: options.input ?? defaultInput,
      output
    });

    return (question: string) => readline!.question(question);
  })();
  const close = options.close ?? (() => readline?.close());
  const onSigint = () => {
    if (activeTurn !== undefined) {
      activeTurn.abort("SIGINT");
      output.write("\nCancelling current turn. Press Ctrl+C again or type /exit to leave.\n");
      return;
    }

    output.write("\nEnding EstaCoda session.\n");
    close();
  };

  process.once("SIGINT", onSigint);

  try {
    output.write(`${options.runtime.describe()}\n\n`);
    output.write("Type a message. Use /help for commands or /exit to leave.\n\n");

    while (true) {
      const text = (await prompt("𓂀 > ")).trim();

      if (text.length === 0) {
        continue;
      }

      if (text === "/exit" || text === "/quit") {
        output.write("Ending EstaCoda session.\n");
        return;
      }

      if (text.startsWith("/")) {
        const shouldExit = await handleSlashCommand({
          text,
          runtime: options.runtime,
          output
        });

        if (shouldExit) {
          return;
        }

        continue;
      }

      output.write("\n");
      activeTurn = new AbortController();
      const response = await options.runtime.handle({
          text,
          channel: "cli",
          signal: activeTurn.signal,
          onEvent: (event) => renderRuntimeEvent(output, event, activityRenderer)
        })
        .finally(() => {
          activeTurn = undefined;
        });

      output.write(`\n${response.label}: ${response.text}\n`);

      if (response.progress.length > 0) {
        output.write(`progress: ${response.progress.join(" -> ")}\n`);
      }

      output.write("\n");
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    close();
  }
}

async function handleSlashCommand(input: {
  text: string;
  runtime: Runtime;
  output: NodeJS.WritableStream;
}): Promise<boolean> {
  const [command = "", ...args] = input.text.slice(1).trim().split(/\s+/u);

  switch (command) {
    case "":
      input.output.write(`${renderSlashMenu(input.runtime)}\n\n`);
      return false;
    case "help":
      input.output.write(`${renderSessionHelp()}\n\n`);
      return false;
    case "status":
    case "model":
      input.output.write(`${input.runtime.describe()}\n\n`);
      return false;
    case "tools":
      input.output.write(`${renderToolsMenu(input.runtime, args.join(" "))}\n\n`);
      return false;
    case "skills":
      input.output.write(`${renderSlashMenu(input.runtime, args.join(" "))}\n\n`);
      return false;
    case "resume":
      input.output.write(`${await renderLatestResume(input.runtime)}\n\n`);
      return false;
    case "trust":
      await input.runtime.trustWorkspace();
      input.output.write("Workspace trusted. EstaCoda will proceed with normal local work here.\n\n");
      return false;
    case "untrust":
      await input.runtime.revokeWorkspaceTrust();
      input.output.write("Workspace trust revoked. EstaCoda will ask before workspace writes here.\n\n");
      return false;
    case "doctor":
      input.output.write(`${await renderRuntimeDoctor(input.runtime)}\n\n`);
      return false;
    case "clear":
      input.output.write("\x1Bc");
      return false;
    case "exit":
    case "quit":
      input.output.write("Ending EstaCoda session.\n");
      return true;
    default:
      if (renderSlashMenu(input.runtime, command).startsWith("No slash commands or skills match") === false) {
        input.output.write(`${renderSlashMenu(input.runtime, command)}\n\n`);
        return false;
      }

      input.output.write(`Unknown command: /${command}\nUse /help to see available commands.\n\n`);
      return false;
  }
}

function renderSessionHelp(): string {
  return [
    "EstaCoda session commands",
    ...SESSION_COMMANDS.map((command) => `/${command.name.padEnd(8)}${command.description}`)
  ].join("\n");
}

async function renderRuntimeDoctor(runtime: Runtime): Promise<string> {
  const trusted = await runtime.isWorkspaceTrusted();
  const tools = runtime.tools();

  return [
    "EstaCoda session doctor",
    `Session: ${runtime.sessionId}`,
    `Workspace trust: ${trusted ? "trusted" : "not trusted"}`,
    `Tools available: ${tools.length}`,
    `Has web tools: ${tools.some((tool) => tool.toolsets.includes("web")) ? "yes" : "no"}`,
    `Has file tools: ${tools.some((tool) => tool.toolsets.includes("files")) ? "yes" : "no"}`,
    `Has process tools: ${tools.some((tool) => tool.toolsets.includes("shell-write")) ? "yes" : "no"}`,
    trusted ? "Status: ready for proactive local work" : "Status: trust this workspace with /trust for proactive local work"
  ].join("\n");
}

async function renderLatestResume(runtime: Runtime): Promise<string> {
  const resumeNote = await runtime.latestResumeNote();

  return resumeNote === undefined
    ? "No interrupted turn is available to resume."
    : [
        "Latest interrupted turn",
        resumeNote
      ].join("\n");
}

function renderRuntimeEvent(
  output: NodeJS.WritableStream,
  event: RuntimeEvent,
  activityRenderer: ToolActivityRenderer
): void {
  switch (event.kind) {
    case "agent-start":
      output.write(`thinking: ${event.input}\n`);
      return;
    case "intent":
      output.write(`intent: ${event.labels.join(", ")} (${Math.round(event.confidence * 100)}%)\n`);
      return;
    case "skill":
      output.write(`☥ skill: ${event.name}\n`);
      return;
    case "tool-start":
      output.write(`${activityRenderer.render(event)}\n`);
      return;
    case "tool-result":
      output.write(`${activityRenderer.render(event)}\n`);
      return;
    case "provider-attempt":
      output.write(event.fallback
        ? `provider: switching to ${event.provider}/${event.model}\n`
        : `provider: using ${event.provider}/${event.model}\n`);
      return;
    case "provider-token":
      output.write(event.text);
      return;
    case "provider-tool-call":
      output.write(`\nprovider tool call: ${event.name ?? "unknown"}\n`);
      return;
    case "provider-result":
      if (event.ok) {
        output.write(`\nprovider: ${event.provider}/${event.model} ready\n`);
        return;
      }

      output.write(event.willFallback
        ? `\nprovider: ${humanProviderIssue(event.errorClass)} on ${event.provider}/${event.model}; trying fallback\n`
        : `\nprovider: ${humanProviderIssue(event.errorClass)} on ${event.provider}/${event.model}\n`);
      return;
    case "provider-budget-exhausted":
      output.write(`\nprovider budget: ${event.reason}\n`);
      return;
    case "agent-cancelled":
      output.write(`\ncancelled: ${event.reason}\n`);
      return;
    case "agent-final":
      return;
  }
}

function humanProviderIssue(errorClass: string | undefined): string {
  switch (errorClass) {
    case "auth":
      return "authentication needs attention";
    case "rate-limit":
      return "rate limited";
    case "quota":
      return "quota or billing limit";
    case "network":
      return "network issue";
    case "server":
      return "provider server issue";
    case "model-unavailable":
      return "model unavailable";
    case "timeout":
      return "timed out";
    case undefined:
      return "provider issue";
    default:
      return errorClass;
  }
}
