import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import type { Runtime } from "../runtime/create-runtime.js";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { SecurityAssessment } from "../contracts/security.js";
import type { SessionEvent } from "../contracts/session.js";
import type { ToolResult } from "../contracts/tool.js";
import { runCronCommand } from "../cron/cron-command.js";
import { createRuntimeCronRunner, tickCron } from "../cron/cron-runner.js";
import { CronStore } from "../cron/cron-store.js";
import { storeCapabilitySecret, type SetupNeededMetadata } from "../capabilities/capability-setup.js";
import { createReadlinePrompt, type Prompt } from "../onboarding/interactive-onboarding.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { renderSlashMenu, renderToolsMenu, SESSION_COMMANDS } from "./slash-menu.js";
import { ToolActivityRenderer, toolIcon } from "./tool-activity-renderer.js";

export type SessionLoopOptions = {
  runtime: Runtime;
  refreshRuntime?: (options?: { preserveSession?: boolean }) => Promise<Runtime>;
  switchRuntime?: (sessionId: string) => Promise<Runtime>;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  prompt?: Prompt;
  close?: () => void;
  workspaceRoot?: string;
  homeDir?: string;
};

export async function runSessionLoop(options: SessionLoopOptions): Promise<void> {
  const output = options.output ?? defaultOutput;
  let runtime = options.runtime;
  let activityRenderer = new ToolActivityRenderer({
    tools: runtime.tools()
  });
  let activeTurn: AbortController | undefined;
  const prompt = options.prompt ?? createReadlinePrompt(options.input as NodeJS.ReadStream | undefined ?? defaultInput, output as NodeJS.WriteStream);
  const close = options.close ?? (() => prompt.close?.());
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
    output.write(`${runtime.describe()}\n\n`);
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
          runtime,
          output,
          refreshRuntime: options.refreshRuntime,
          switchRuntime: options.switchRuntime,
          workspaceRoot: options.workspaceRoot
        });

        if (typeof shouldExit !== "boolean") {
          await runtime.dispose();
          runtime = shouldExit.runtime;
          activityRenderer = new ToolActivityRenderer({
            tools: runtime.tools()
          });
          output.write(`${shouldExit.notice(runtime)}\n\n`);
          continue;
        }

        if (shouldExit) {
          return;
        }

        continue;
      }

      let retryText: string | undefined = text;
      while (retryText !== undefined) {
        output.write("\n");
        activeTurn = new AbortController();
        const response = await runtime.handle({
            text: retryText,
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

        const setupResolution = await maybeHandleSetupNeeded({
          runtime,
          prompt,
          output,
          homeDir: options.homeDir,
          execution: response.toolExecutions.find(hasSetupNeededResult)
        });

        if (setupResolution.handled) {
          output.write(`${setupResolution.message}\n\n`);
          retryText = undefined;
          continue;
        }

        const approvalResolution = await maybeHandleApprovalGate({
          runtime,
          prompt,
          output,
          execution: response.toolExecutions.find((execution) => execution.decision === "ask")
        });

        if (approvalResolution.retry === false) {
          if (approvalResolution.message !== undefined) {
            output.write(`${approvalResolution.message}\n`);
          }
          output.write("\n");
          retryText = undefined;
          continue;
        }

        output.write(`${approvalResolution.message}\n\n`);
        retryText = text;
      }
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    await runtime.dispose();
    close();
  }
}

async function handleSlashCommand(input: {
  text: string;
  runtime: Runtime;
  refreshRuntime?: (options?: { preserveSession?: boolean }) => Promise<Runtime>;
  switchRuntime?: (sessionId: string) => Promise<Runtime>;
  output: NodeJS.WritableStream;
  workspaceRoot?: string;
}): Promise<boolean | { runtime: Runtime; notice: (runtime: Runtime) => string }> {
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
    case "reset":
    case "new":
      if (input.refreshRuntime === undefined) {
        input.output.write("This session cannot reset itself here. Start a new EstaCoda session to refresh skills and config.\n\n");
        return false;
      }

      return {
        runtime: await input.refreshRuntime({ preserveSession: false }),
        notice: (runtime) => [
          `Started fresh session ${runtime.sessionId}.`,
          "Skills and config were refreshed for this new session.",
          "",
          runtime.describe()
        ].join("\n")
      };
    case "tools":
      input.output.write(`${renderToolsMenu(input.runtime, args.join(" "))}\n\n`);
      return false;
    case "browser": {
      const result = await handleBrowserCommand(input, args);
      if (typeof result === "string") {
        input.output.write(`${result}\n\n`);
        return false;
      }
      return result;
    }
    case "memory":
      input.output.write(`${await renderMemoryPromotions(input.runtime)}\n\n`);
      return false;
    case "skills":
      input.output.write(`${renderSlashMenu(input.runtime, args.join(" "))}\n\n`);
      return false;
    case "reload-mcp":
      if (input.refreshRuntime === undefined) {
        input.output.write("This session cannot reload MCP configuration here.\n\n");
        return false;
      }

      return {
        runtime: await input.refreshRuntime({ preserveSession: true }),
        notice: (runtime) => {
          const snapshots = runtime.inspectMcpServers();
          const configured = snapshots.length;
          const ready = snapshots.filter((snapshot) => snapshot.available).length;
          return [
            "Reloaded MCP configuration for this session.",
            configured === 0
              ? "No MCP servers are configured."
              : `MCP servers ready: ${ready}/${configured}.`,
            "",
            runtime.describe()
          ].join("\n");
        }
      };
    case "resume":
      input.output.write(`${await renderLatestResume(input.runtime)}\n\n`);
      return false;
    case "approvals":
      input.output.write(`${await renderApprovalStatus(input.runtime)}\n\n`);
      return false;
    case "security":
      input.output.write(`${await renderSecurityAudit(input.runtime, {
        debug: args.includes("debug") || args.includes("--debug")
      })}\n\n`);
      return false;
    case "yolo": {
      if (input.runtime.toggleYoloMode === undefined) {
        input.output.write("This session cannot toggle YOLO mode here.\n\n");
        return false;
      }
      const result = input.runtime.toggleYoloMode();
      input.output.write(result.enabled
        ? "⚡ YOLO mode ON — EstaCoda will auto-approve eligible actions for this session. Hard safety blocks still apply.\n\n"
        : `⚠ YOLO mode OFF — risky actions will use ${result.mode} approval mode.\n\n`);
      return false;
    }
    case "cron": {
      const store = new CronStore();
      const result = await runCronCommand({
        args,
        store,
        tick: async () => {
          const results = await tickCron({
            store,
            runner: createRuntimeCronRunner({
              runtimeFactory: async () => input.runtime,
              wrapResponse: true,
              disposeRuntime: false,
              workspaceRoot: input.workspaceRoot
            })
          });
          return results.length === 0
            ? "Cron tick complete. No due jobs."
            : [
                `Cron tick complete. Ran ${results.length} job(s).`,
                ...results.map((entry) => `${entry.job.id}: ${entry.ok ? "succeeded" : "failed"}`)
              ].join("\n");
        }
      });
      input.output.write(`${result.output}\n\n`);
      return false;
    }
    case "revoke": {
      const approvalId = args[0];
      if (approvalId === undefined || approvalId.length === 0) {
        input.output.write("Usage: /revoke <approval-id>\n\n");
        return false;
      }
      if (input.runtime.revokeApproval === undefined) {
        input.output.write("This session does not support persistent approval revocation here.\n\n");
        return false;
      }
      const revoked = await input.runtime.revokeApproval(approvalId);
      input.output.write(`${revoked ? `Revoked persistent approval ${approvalId}.` : `No persistent approval matched ${approvalId}.`}\n\n`);
      return false;
    }
    case "sessions":
      input.output.write(`${await renderSessionList(input.runtime)}\n\n`);
      return false;
    case "search":
      input.output.write(`${await renderSessionSearch(input.runtime, args.join(" "))}\n\n`);
      return false;
    case "switch": {
      const target = args[0];
      if (target === undefined || target.length === 0) {
        input.output.write("Usage: /switch <session-id>\n\n");
        return false;
      }
      if (input.switchRuntime === undefined) {
        input.output.write("This session cannot switch sessions here.\n\n");
        return false;
      }
      const targetSession = await input.runtime.sessionDb.getSession(target);
      if (targetSession === undefined) {
        input.output.write(`Session not found: ${target}\n\n`);
        return false;
      }
      return {
        runtime: await input.switchRuntime(target),
        notice: (runtime) => [
          "Switched this session to an existing session.",
          `Session: ${runtime.sessionId}`,
          "",
          runtime.describe()
        ].join("\n")
      };
    }
    case "trust":
    case "workspace.trust.grant":
      await input.runtime.trustWorkspace();
      input.output.write("Workspace trusted. EstaCoda will proceed with normal local work here.\n\n");
      return false;
    case "untrust":
    case "workspace.trust.revoke":
      await input.runtime.revokeWorkspaceTrust();
      input.output.write("Workspace trust revoked. EstaCoda will ask before workspace writes here.\n\n");
      return false;
    case "workspace.trust.status": {
      const trusted = await input.runtime.isWorkspaceTrusted();
      input.output.write(`Workspace trust: ${trusted ? "trusted" : "not trusted"}\n\n`);
      return false;
    }
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

async function renderSecurityAudit(runtime: Runtime, options: { debug: boolean }): Promise<string> {
  const events = await runtime.sessionDb.listEvents(runtime.sessionId);
  const securityEvents = events
    .filter((event): event is Extract<SessionEvent, { kind: "security-assessed" }> => event.kind === "security-assessed")
    .slice(-8)
    .reverse();

  if (securityEvents.length === 0) {
    return [
      "Security audit",
      "No tool security decisions have been recorded for this session yet."
    ].join("\n");
  }

  return [
    "Security audit",
    ...securityEvents.map((event, index) =>
      options.debug
        ? renderSecurityEventDebug(index + 1, event)
        : renderSecurityEventCompact(index + 1, event)
    )
  ].join("\n");
}

function renderSecurityEventCompact(
  index: number,
  event: Extract<SessionEvent, { kind: "security-assessed" }>
): string {
  return [
    `${index}. ${event.tool} -> ${event.assessment.decision}`,
    `   risk=${event.riskClass} rule=${event.assessment.deterministicRule ?? "policy"}`,
    event.targetSummary === undefined ? undefined : `   target=${truncateSingleLine(event.targetSummary, 96)}`,
    `   reason=${truncateSingleLine(event.assessment.reason, 120)}`
  ].filter((line): line is string => typeof line === "string").join("\n");
}

function renderSecurityEventDebug(
  index: number,
  event: Extract<SessionEvent, { kind: "security-assessed" }>
): string {
  const assessment = event.assessment;
  return [
    `${index}. ${event.tool}`,
    `   final decision: ${assessment.decision}`,
    `   mode: ${assessment.mode}`,
    `   risk: ${assessment.risk}`,
    `   risk class: ${event.riskClass}`,
    `   deterministic rule: ${assessment.deterministicRule ?? "none"}`,
    event.targetKey === undefined ? undefined : `   target key: ${truncateSingleLine(event.targetKey, 140)}`,
    event.targetSummary === undefined ? undefined : `   target: ${truncateSingleLine(event.targetSummary, 140)}`,
    `   reason: ${assessment.reason}`,
    `   assessor: ${renderAssessorDebug(assessment)}`
  ].filter((line): line is string => typeof line === "string").join("\n");
}

function renderAssessorDebug(assessment: SecurityAssessment): string {
  const assessor = assessment.assessor;
  if (assessor === undefined) {
    return "not used";
  }

  if (assessor.used !== true) {
    return `not used (${assessor.status ?? "disabled"})`;
  }

  return [
    `used status=${assessor.status ?? "unknown"}`,
    assessor.provider === undefined ? undefined : `provider=${assessor.provider}`,
    assessor.model === undefined ? undefined : `model=${assessor.model}`,
    assessor.decision === undefined ? undefined : `decision=${assessor.decision}`,
    assessor.risk === undefined ? undefined : `risk=${assessor.risk}`,
    assessor.confidence === undefined ? undefined : `confidence=${assessor.confidence}`,
    assessor.reason === undefined ? undefined : `reason=${truncateSingleLine(assessor.reason, 80)}`
  ].filter((part): part is string => typeof part === "string").join(" ");
}

async function maybeHandleApprovalGate(input: {
  runtime: Runtime;
  prompt: (question: string) => Promise<string>;
  output: NodeJS.WritableStream;
  execution: ToolExecutionRecord | undefined;
}): Promise<{
  retry: boolean;
  message?: string;
}> {
  const execution = input.execution;
  if (execution === undefined || input.runtime.grantApproval === undefined) {
    return {
      retry: false
    };
  }

  while (true) {
    const answer = (await input.prompt(renderApprovalPrompt(execution))).trim().toLowerCase();
    if (answer === "deny" || answer === "reject" || answer === "no" || answer === "n") {
      return {
        retry: false,
        message: "Permission denied."
      };
    }

    const scope = normalizeApprovalScope(answer);
    if (scope === undefined) {
      input.output.write("Enter one of: once, session, always, deny.\n\n");
      continue;
    }

    await input.runtime.grantApproval({
      toolName: execution.tool.name,
      riskClass: execution.riskClass,
      targetKey: execution.targetKey,
      targetSummary: execution.targetSummary,
      scope
    });

    return {
      retry: true,
      message: scope === "always"
        ? "Approval granted (persistent for this workspace). Retrying now."
        : `Approval granted (${scope}). Retrying now.`
    };
  }
}

async function maybeHandleSetupNeeded(input: {
  runtime: Runtime;
  prompt: Prompt;
  output: NodeJS.WritableStream;
  homeDir?: string;
  execution: ToolExecutionRecord | undefined;
}): Promise<{
  handled: boolean;
  message: string;
}> {
  const execution = input.execution;
  const setup = setupNeededMetadata(execution?.result);
  if (execution === undefined || setup === undefined) {
    return {
      handled: false,
      message: ""
    };
  }

  if (setup.capability !== "image_generation" || execution.tool.name !== "image.generate") {
    return {
      handled: true,
      message: `Setup is required for ${setup.capability}. This CLI session cannot complete that setup flow yet.`
    };
  }

  const provider = setup.provider === "byteplus" ? "byteplus" : "fal";
  const model = typeof setup.model === "string" && setup.model.length > 0
    ? setup.model
    : provider === "byteplus" ? "seedream-4-0-250828" : "fal-ai/flux-2/klein/9b";
  const requiredSecret = setup.requiredSecret;
  input.output.write([
    "",
    "Image generation needs one protected credential before I can continue.",
    `Provider: ${provider}`,
    `Model: ${model}`,
    `Secret env: ${requiredSecret}`,
    "The key is captured by the CLI and is not sent to the model or written to the transcript.",
    ""
  ].join("\n"));

  const secret = await input.prompt(`Paste ${requiredSecret} (or type cancel): `, { secret: true });
  if (secret.trim().length === 0 || ["cancel", "c", "no", "n"].includes(secret.trim().toLowerCase())) {
    return {
      handled: true,
      message: "Image setup cancelled. The original image request was not retried."
    };
  }

  const stored = await storeCapabilitySecret({
    homeDir: input.homeDir,
    envName: requiredSecret,
    secret
  });
  const setupExecution = await input.runtime.executeTool?.({
    tool: "config.image.setup",
    toolInput: {
      provider,
      model,
      apiKeyEnv: stored.envName
    }
  });
  if (setupExecution?.result?.ok !== true) {
    return {
      handled: true,
      message: [
        "Image setup could not be saved.",
        setupExecution?.result?.content ?? "No setup result was returned.",
        "The original image request was not retried."
      ].join("\n")
    };
  }

  const verification = await input.runtime.verifyImageGeneration?.();
  if (verification?.ok !== true) {
    return {
      handled: true,
      message: [
        "Image setup was saved, but verification did not pass.",
        verification?.message ?? "Image verification is unavailable in this runtime.",
        "The original image request was not retried."
      ].join("\n")
    };
  }

  input.output.write("Image setup verified. Resuming the original image request...\n");
  await renderManualToolExecution(input.output, input.runtime, {
    tool: execution.tool.name,
    toolInput: execution.input ?? {}
  });

  return {
    handled: true,
    message: "Image generation resumed after setup."
  };
}

async function renderManualToolExecution(
  output: NodeJS.WritableStream,
  runtime: Runtime,
  input: {
    tool: string;
    toolInput: Record<string, unknown>;
  }
): Promise<void> {
  output.write(`${toolIcon(input.tool)} calling ${input.tool}\n`);
  const execution = await runtime.executeTool?.(input);
  if (execution === undefined) {
    output.write(`${toolIcon(input.tool)} ${input.tool} unavailable\n`);
    return;
  }

  output.write(`${toolIcon(input.tool)} ${input.tool} ${execution.result?.ok === true ? "done" : "failed"}\n`);
  if (execution.result?.content !== undefined && execution.result.content.length > 0) {
    output.write(`${execution.result.content}\n`);
  }
}

function hasSetupNeededResult(execution: ToolExecutionRecord): boolean {
  return setupNeededMetadata(execution.result) !== undefined;
}

function setupNeededMetadata(result: ToolResult | undefined): SetupNeededMetadata | undefined {
  const metadata = result?.metadata;
  if (metadata?.kind !== "setup_needed") {
    return undefined;
  }
  if (typeof metadata.capability !== "string" || typeof metadata.requiredSecret !== "string") {
    return undefined;
  }
  return metadata as SetupNeededMetadata;
}

function renderApprovalPrompt(execution: ToolExecutionRecord): string {
  const details = [
    "",
    "Approval required",
    `Tool: ${execution.tool.name}`,
    `Risk: ${execution.riskClass}`,
    execution.targetSummary === undefined ? undefined : `Target: ${execution.targetSummary}`,
    "Choose once, session, always, or deny",
    "approval > "
  ].filter((line): line is string => typeof line === "string");

  return details.join("\n");
}

function normalizeApprovalScope(value: string): "once" | "session" | "always" | undefined {
  if (value === "once" || value === "1") return "once";
  if (value === "session" || value === "2") return "session";
  if (value === "always" || value === "persist" || value === "3") return "always";
  return undefined;
}

async function renderApprovalStatus(runtime: Runtime): Promise<string> {
  const approvals = await runtime.inspectApprovals?.();
  if (approvals === undefined) {
    return "This session does not expose approval state here.";
  }

  return [
    "Approval status",
    "",
    "Session approvals:",
    ...(approvals.session.length === 0
      ? ["none"]
      : approvals.session.map((grant, index) =>
          `${index + 1}. scope=${grant.scope} tool=${grant.toolName} risk=${grant.riskClass}${grant.targetSummary === undefined ? "" : ` target=${grant.targetSummary}`}`
        )),
    "",
    "Persistent approvals:",
    ...(approvals.persistent.length === 0
      ? ["none"]
      : approvals.persistent.map((grant, index) =>
          `${index + 1}. [${grant.id}] tool=${grant.toolName} risk=${grant.riskClass}${grant.targetSummary === undefined ? "" : ` target=${grant.targetSummary}`}`
        )),
    "",
    "Use /revoke <approval-id> to remove a persistent approval."
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

async function handleBrowserCommand(input: {
  runtime: Runtime;
  refreshRuntime?: (options?: { preserveSession?: boolean }) => Promise<Runtime>;
}, args: string[]): Promise<string | { runtime: Runtime; notice: (runtime: Runtime) => string }> {
  const [subcommand = "status", value] = args;

  if (subcommand === "status") {
    const execution = await input.runtime.executeTool?.({
      tool: "browser.status",
      toolInput: {}
    });
    return execution?.result?.content ?? "Browser status is not available in this session.";
  }

  if (subcommand === "connect") {
    const cdpUrl = value ?? "http://127.0.0.1:9222";
    const execution = await input.runtime.executeTool?.({
      tool: "config.browser.setup",
      toolInput: {
        backend: "local-cdp",
        cdpUrl
      }
    });
    if (execution?.result?.ok !== true) {
      return execution?.result?.content ?? "Could not configure local CDP browser backend.";
    }
    if (input.refreshRuntime === undefined) {
      return `${execution.result.content}\nRestart this EstaCoda session to use the new browser backend.`;
    }
    return {
      runtime: await input.refreshRuntime({ preserveSession: true }),
      notice: (runtime) => [
        `Connected browser backend to ${cdpUrl}.`,
        "Refreshed this session so browser tools use the new CDP endpoint.",
        "",
        runtime.describe()
      ].join("\n")
    };
  }

  if (subcommand === "disconnect") {
    const execution = await input.runtime.executeTool?.({
      tool: "config.browser.setup",
      toolInput: {
        backend: "unconfigured"
      }
    });
    if (execution?.result?.ok !== true) {
      return execution?.result?.content ?? "Could not disconnect browser backend.";
    }
    if (input.refreshRuntime === undefined) {
      return `${execution.result.content}\nRestart this EstaCoda session to use the updated browser backend.`;
    }
    return {
      runtime: await input.refreshRuntime({ preserveSession: true }),
      notice: (runtime) => [
        "Disconnected browser backend for this profile.",
        "",
        runtime.describe()
      ].join("\n")
    };
  }

  return [
    "EstaCoda browser",
    "  /browser status",
    "  /browser connect",
    "  /browser connect http://127.0.0.1:9222",
    "  /browser disconnect"
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

async function renderSessionList(runtime: Runtime): Promise<string> {
  const sessions = (await runtime.sessionDb.listSessions("default")).slice(0, 10);
  if (sessions.length === 0) {
    return "No sessions found.";
  }

  return [
    "Recent sessions",
    ...sessions.map((session, index) =>
      `${index + 1}. ${session.id}${session.id === runtime.sessionId ? " (active)" : ""}${session.updatedAt ? ` — updated ${session.updatedAt}` : ""}`
    )
  ].join("\n");
}

async function renderSessionSearch(runtime: Runtime, query: string): Promise<string> {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) {
    return "Usage: /search <query>";
  }

  const matches = await runtime.sessionDb.search(normalizedQuery, {
    profileId: "default",
    limit: 5
  });
  if (matches.length === 0) {
    return `No matching session history for "${normalizedQuery}".`;
  }

  return [
    `Search results for "${normalizedQuery}"`,
    ...matches.map((result, index) =>
      `${index + 1}. [${result.session.id}] ${result.message.role}: ${truncateSingleLine(result.message.content, 100)}`
    )
  ].join("\n");
}

async function renderMemoryPromotions(runtime: Runtime): Promise<string> {
  const promotions = await runtime.inspectMemoryPromotions();
  if (promotions.length === 0) {
    return "No promoted memory conclusions found.";
  }

  return [
    "Promoted memory conclusions",
    ...promotions.map((record, index) => {
      const state = record.active ? "active" : record.forgottenAt !== undefined ? "forgotten" : "inactive";
      const source = record.sourceSessionIds.length === 0 ? "no session provenance" : `${record.sourceSessionIds.length} session${record.sourceSessionIds.length === 1 ? "" : "s"}`;
      return `${index + 1}. ${record.content} [${state}; occurrences:${record.occurrences}; ${source}]`;
    })
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
      output.write(`\n${toolIcon(event.name ?? "")} provider requested ${event.name ?? "unknown"}\n`);
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

function truncateSingleLine(value: string, maxLength: number): string {
  const singleLine = value.replace(/\s+/gu, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }

  return `${singleLine.slice(0, Math.max(0, maxLength - 1))}…`;
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
