import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import type { Runtime } from "../runtime/create-runtime.js";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { SecurityAssessment } from "../contracts/security.js";
import type { SessionEvent } from "../contracts/session.js";
import type { ToolResult } from "../contracts/tool.js";
import { runCronCommand } from "../cron/cron-command.js";
import { createRuntimeCronRunner, tickCron } from "../cron/cron-runner.js";
import { CronStore } from "../cron/cron-store.js";
import { storeCapabilitySecret, type SetupNeededMetadata } from "../setup/capability-setup.js";
import { defaultImageModel } from "../contracts/image-generation.js";
import { createReadlinePrompt, type Prompt } from "../onboarding/interactive-onboarding.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { renderSlashMenu, renderToolsMenu, buildSlashMenuViewModel, buildToolsMenuViewModel } from "./slash-menu.js";
import { renderSessionHelp, buildSessionHelpViewModel } from "./session-help.js";
import { commandRegistry } from "./command-registry.js";
import { ToolActivityRenderer, toolIcon } from "./tool-activity-renderer.js";
import {
  ToolActivityViewModelBuilder,
  buildApprovalPromptViewModel,
  buildSecurityAuditViewModel,
  buildSetupNeededViewModel,
} from "./tool-activity-view-models.js";
import {
  buildActiveTurnSpinnerViewModel,
  buildAssistantResponseViewModel,
  buildSessionStatusRailViewModel,
  buildUserPromptRailViewModel,
} from "../ui/view-models/builders.js";
import { createSessionRenderer, type SessionRenderer } from "./session-renderer.js";
import type { ResolvedTokens } from "../contracts/ui-tokens.js";
import { renderPlain } from "../ui/renderers/plain-renderer.js";
import { PromptChromeController } from "./prompt-chrome-controller.js";
import { chromeCopy } from "../ui/cli-ui-copy.js";

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
  locale?: import("../contracts/ui.js").UiLocale;
};

export async function runSessionLoop(options: SessionLoopOptions): Promise<void> {
  const output = options.output ?? defaultOutput;
  const renderer = createSessionRenderer({ output, locale: options.locale });
  let runtime = options.runtime;
  let activityBuilder = new ToolActivityViewModelBuilder({
    tools: runtime.tools()
  });
  let activeTurn: AbortController | undefined;
  const prompt = options.prompt ?? createReadlinePrompt(options.input as NodeJS.ReadStream | undefined ?? defaultInput, output as NodeJS.WriteStream);
  const close = options.close ?? (() => prompt.close?.());
  const chrome = new PromptChromeController({
    output,
    capabilities: renderer.capabilities,
    renderViewModel: (vm) => renderer.render(vm),
    enabled: renderer.capabilities.isTTY && !renderer.capabilities.isCI && !renderer.capabilities.isDumb && renderer.capabilities.supportsColor && renderer.tokens.contract.behavior.allowAnsiColor,
  });
  const onSigint = () => {
    chrome.clearInlineSpinner();
    chrome.clearChrome();
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
    const startupVm = typeof runtime.getStartup === "function" ? runtime.getStartup() : undefined;
    const startupText = startupVm !== undefined ? renderer.render(startupVm) : runtime.describe();
    output.write(`${startupText}\n\n`);
    output.write("Type a message. Use /help for commands or /exit to leave.\n\n");

    const promptPrefix = renderer.tokens.contract.branding.promptPrefix ?? `${renderer.tokens.contract.glyph.prompt} `;
    const useColor = renderer.capabilities.supportsColor && renderer.tokens.contract.behavior.allowAnsiColor;
    const useUnicode = renderer.capabilities.supportsUnicode;
    const termWidth = renderer.capabilities.terminalWidth;

    while (true) {
      if (chrome.enabled) {
        chrome.renderChrome(buildPromptChromeState(runtime, renderer));
      } else {
        const topRule = renderHorizontalRule(renderer.tokens, useColor, useUnicode, termWidth);
        output.write(`${topRule}\n`);
      }

      const text = (await prompt(colorPromptPrefix(promptPrefix, renderer.tokens, useColor))).trim();

      if (chrome.enabled) {
        chrome.clearChrome();
      } else {
        const topRule = renderHorizontalRule(renderer.tokens, useColor, useUnicode, termWidth);
        output.write(`${topRule}\n`);
      }

      if (text.length === 0) {
        continue;
      }

      if (text === "/exit") {
        output.write("Ending EstaCoda session.\n");
        return;
      }

      if (text.startsWith("/")) {
        const shouldExit = await handleSlashCommand({
          text,
          runtime,
          output,
          renderer,
          refreshRuntime: options.refreshRuntime,
          switchRuntime: options.switchRuntime,
          workspaceRoot: options.workspaceRoot,
          homeDir: options.homeDir
        });

        if (typeof shouldExit !== "boolean") {
          await runtime.dispose();
          runtime = shouldExit.runtime;
          activityBuilder = new ToolActivityViewModelBuilder({
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

      // Render submitted non-slash user prompts as lightweight transcript rails
      const userPromptRail = buildUserPromptRailViewModel({ text });
      const userPromptRailText = renderer.render(userPromptRail);
      if (chrome.enabled) {
        await chrome.suspendChromeForTranscript(() => {
          output.write(`${userPromptRailText}\n`);
        });
      } else {
        output.write(`${userPromptRailText}\n`);
      }

      let retryText: string | undefined = text;
      while (retryText !== undefined) {
        output.write("\n");
        activeTurn = new AbortController();
        const streamState = { lastWriteEndedWithNewline: true };
        const turnOutput = { spinnerPhase: undefined as string | undefined, hasOutput: false, lastOutputWasSpinner: false };

        const renderSpinner = (phase: string) => {
          if (chrome.enabled) {
            chrome.renderInlineSpinner(phase, (p) => renderer.render(buildActiveTurnSpinnerViewModel({ phase: p })));
          }
        };

        const clearSpinner = () => {
          if (chrome.enabled) {
            chrome.clearInlineSpinner();
          } else {
            if (turnOutput.spinnerPhase !== undefined && turnOutput.lastOutputWasSpinner) {
              output.write(`\x1b[1A\x1b[2K\r`);
            }
          }
          turnOutput.spinnerPhase = undefined;
          turnOutput.lastOutputWasSpinner = false;
        };

        if (chrome.enabled) {
          renderSpinner("thinking");
        }

        const response = await runtime.handle({
            text: retryText,
            channel: "cli",
            signal: activeTurn.signal,
            onEvent: (event) => {
              const newPhase = renderRuntimeEvent(output, event, activityBuilder, renderer, streamState, chrome, turnOutput);
              if (newPhase !== undefined && chrome.enabled) {
                renderSpinner(newPhase);
              }
            }
          })
          .finally(() => {
            activeTurn = undefined;
          })
          .finally(() => {
            clearSpinner();
          });

        const assistantVm = buildAssistantResponseViewModel({
          label: response.label,
          text: response.text,
          matchedSkills: response.matchedSkills,
          progress: response.progress,
        });
        output.write(renderer.render(assistantVm));

        const setupResolution = await maybeHandleSetupNeeded({
          runtime,
          prompt,
          output,
          renderer,
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
          renderer,
          chrome,
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
    chrome.dispose();
    await runtime.dispose();
    close();
  }
}

export async function handleSlashCommand(input: {
  text: string;
  runtime: Runtime;
  refreshRuntime?: (options?: { preserveSession?: boolean }) => Promise<Runtime>;
  switchRuntime?: (sessionId: string) => Promise<Runtime>;
  output: NodeJS.WritableStream;
  renderer: { render(viewModel: import("../contracts/view-model.js").ViewModel): string };
  workspaceRoot?: string;
  homeDir?: string;
}): Promise<boolean | { runtime: Runtime; notice: (runtime: Runtime) => string }> {
  const [command = "", ...args] = input.text.slice(1).trim().split(/\s+/u);
  const resolved = commandRegistry.resolve(command);
  const canonical = resolved?.name ?? command;

  switch (canonical) {
    case "":
      input.output.write(`${input.renderer.render(buildSlashMenuViewModel(input.runtime))}\n\n`);
      return false;
    case "help":
      input.output.write(`${input.renderer.render(buildSessionHelpViewModel())}\n\n`);
      return false;
    case "status":
      input.output.write(`${input.renderer.render(input.runtime.getStatus())}\n\n`);
      return false;
    case "model": {
      if (args[0] === "set" && args[1] !== undefined) {
        input.output.write(
          "Session-scoped model switching is not supported. Use `estacoda model set <provider>/<model>` to change the persistent configuration.\n\n"
        );
        return false;
      }

      input.output.write(`${input.renderer.render(input.runtime.getModelInfo())}\n\n`);
      return false;
    }
    case "reset":
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
      input.output.write(`${input.renderer.render(buildToolsMenuViewModel(input.runtime, args.join(" ")))}\n\n`);
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
      input.output.write(`${input.renderer.render(buildSlashMenuViewModel(input.runtime, args.join(" ")))}\n\n`);
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
      }, input.renderer)}\n\n`);
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
      await input.runtime.trustWorkspace();
      input.output.write("Workspace trusted. EstaCoda will proceed with normal local work here.\n\n");
      return false;
    case "untrust":
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
    case "flow": {
      const result = await handleTaskFlowCommand(input, args);
      input.output.write(`${result}\n\n`);
      return false;
    }
    case "handoff": {
      const surface = args[0] ?? "telegram";
      if (surface !== "telegram") {
        input.output.write(`Unsupported surface: ${surface}. Currently only 'telegram' is supported.\n\n`);
        return false;
      }
      const { FileHandoffStore } = await import("../channels/handoff-store.js");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const store = new FileHandoffStore({ path: join(homedir(), ".estacoda", "handoff-codes.json") });
      const handoff = await store.create({
        sessionId: input.runtime.sessionId,
        surfaceType: surface,
        ttlMinutes: 10
      });
      input.output.write([
        `Handoff code for Telegram: ${handoff.code}`,
        `Session: ${input.runtime.sessionId}`,
        `Expires: ${handoff.expiresAt}`,
        "",
        `To attach, send in Telegram: /attach ${handoff.code}`,
        ""
      ].join("\n"));
      return false;
    }
    case "clear":
      input.output.write("\x1Bc");
      return false;
    case "exit":
      input.output.write("Ending EstaCoda session.\n");
      return true;
    default:
      if (renderSlashMenu(input.runtime, command).startsWith("No slash commands or skills match") === false) {
        input.output.write(`${input.renderer.render(buildSlashMenuViewModel(input.runtime, command))}\n\n`);
        return false;
      }

      input.output.write(`Unknown command: /${command}\nUse /help to see available commands.\n\n`);
      return false;
  }
}

async function handleTaskFlowCommand(input: {
  runtime: Runtime;
  output: NodeJS.WritableStream;
}, args: string[]): Promise<string> {
  if (input.runtime.taskflow === undefined) {
    return "TaskFlow is not available. It requires SQLite session persistence.";
  }

  const { taskflow } = input.runtime;
  const [subcommand = "", ...rest] = args;

  switch (subcommand) {
    case "":
    case "help":
      return [
        "TaskFlow operator commands (v0.8)",
        "  /flow status [flowId]           Show flow status (active flow if omitted)",
        "  /flow pause <flowId> [reason]   Request pause at next safe boundary",
        "  /flow resume <flowId>           Resume a paused/interrupted/waiting flow",
        "  /flow interrupt <flowId> [r]    Interrupt a running flow",
        "  /flow cancel <flowId> [reason]  Cancel a flow",
        "  /flow steer <flowId> <text...>  Inject operator guidance into a flow",
        "  /flow approve <stepId>          Approve a pending approval gate",
        "  /flow reject <stepId> [reason]  Reject a pending approval gate",
        "  /flow retry <stepId>            Retry a failed step",
        "  /flow skip <stepId> [reason]    Skip a skippable step",
        "  /flow checkpoint <flowId> <n>   Create a named checkpoint",
        "  /flow trace [flowId] [limit]    Show flow trace",
        "  /flow compact <flowId>          Compact flow events",
        "  /flow set <flowId>              Set active flow for this session",
        "  /flow unset                     Clear active flow"
      ].join("\n");

    case "status": {
      const flowId = rest[0] ?? taskflow.activeFlowId ?? undefined;
      if (flowId === undefined) return "No active flow. Use /flow set <flowId> or pass a flow ID.";
      const result = await taskflow.dispatcher.dispatch({ command: "/status", flowId });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "pause": {
      const flowId = rest[0];
      if (flowId === undefined) return "Usage: /flow pause <flowId> [reason]";
      const result = await taskflow.dispatcher.dispatch({
        command: "/pause",
        flowId,
        reason: rest.slice(1).join(" ") || undefined,
        operator: "cli"
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "resume": {
      const flowId = rest[0];
      if (flowId === undefined) return "Usage: /flow resume <flowId>";
      const result = await taskflow.dispatcher.dispatch({
        command: "/resume",
        flowId,
        operator: "cli"
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "interrupt": {
      const flowId = rest[0];
      if (flowId === undefined) return "Usage: /flow interrupt <flowId> [reason]";
      const result = await taskflow.dispatcher.dispatch({
        command: "/interrupt",
        flowId,
        reason: rest.slice(1).join(" ") || undefined,
        operator: "cli"
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "cancel": {
      const flowId = rest[0];
      if (flowId === undefined) return "Usage: /flow cancel <flowId> [reason]";
      const result = await taskflow.dispatcher.dispatch({
        command: "/cancel",
        flowId,
        reason: rest.slice(1).join(" ") || undefined,
        operator: "cli"
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "steer": {
      const flowId = rest[0];
      if (flowId === undefined) return "Usage: /flow steer <flowId> <guidance>";
      const guidance = rest.slice(1).join(" ");
      if (guidance.length === 0) return "Usage: /flow steer <flowId> <guidance>";
      const result = await taskflow.dispatcher.dispatch({
        command: "/steer",
        flowId,
        guidance,
        operator: "cli"
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "approve": {
      const stepId = rest[0];
      if (stepId === undefined) return "Usage: /flow approve <stepId>";
      const result = await taskflow.dispatcher.dispatch({
        command: "/approve",
        stepId,
        operator: "cli"
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "reject": {
      const stepId = rest[0];
      if (stepId === undefined) return "Usage: /flow reject <stepId> [reason]";
      const result = await taskflow.dispatcher.dispatch({
        command: "/reject",
        stepId,
        reason: rest.slice(1).join(" ") || undefined,
        operator: "cli"
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "retry": {
      const stepId = rest[0];
      if (stepId === undefined) return "Usage: /flow retry <stepId>";
      const result = await taskflow.dispatcher.dispatch({
        command: "/retry",
        stepId,
        operator: "cli"
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "skip": {
      const stepId = rest[0];
      if (stepId === undefined) return "Usage: /flow skip <stepId> [reason]";
      const result = await taskflow.dispatcher.dispatch({
        command: "/skip",
        stepId,
        reason: rest.slice(1).join(" ") || undefined,
        operator: "cli"
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "checkpoint": {
      const flowId = rest[0];
      if (flowId === undefined) return "Usage: /flow checkpoint <flowId> <name>";
      const name = rest.slice(1).join(" ");
      if (name.length === 0) return "Usage: /flow checkpoint <flowId> <name>";
      const result = await taskflow.dispatcher.dispatch({
        command: "/checkpoint",
        flowId,
        name,
        operator: "cli"
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "trace": {
      const flowId = rest[0] ?? taskflow.activeFlowId ?? undefined;
      const limit = flowId !== undefined && rest[1] !== undefined ? parseInt(rest[1], 10) : undefined;
      if (flowId === undefined) return "No active flow. Use /flow set <flowId> or pass a flow ID.";
      const result = await taskflow.dispatcher.dispatch({
        command: "/trace",
        flowId,
        limit: Number.isNaN(limit) ? undefined : limit
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "compact": {
      const flowId = rest[0];
      if (flowId === undefined) return "Usage: /flow compact <flowId>";
      const result = await taskflow.dispatcher.dispatch({
        command: "/compact",
        flowId,
        operator: "cli"
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "set": {
      const flowId = rest[0];
      if (flowId === undefined) return "Usage: /flow set <flowId>";
      const flow = await taskflow.store.getFlow(flowId);
      if (flow === null) return `Flow not found: ${flowId}`;
      taskflow.setActiveFlowId(flowId);
      return `Active flow set to ${flowId} (status: ${flow.status}).`;
    }

    case "unset": {
      taskflow.setActiveFlowId(null);
      return "Active flow cleared. Normal agent mode.";
    }

    default:
      return `Unknown flow command: ${subcommand}\nUse /flow help for available commands.`;
  }
}

async function renderSecurityAudit(
  runtime: Runtime,
  options: { debug: boolean },
  renderer: { render(viewModel: import("../contracts/view-model.js").ViewModel): string }
): Promise<string> {
  const events = await runtime.sessionDb.listEvents(runtime.sessionId);
  const securityEvents = events
    .filter((event): event is Extract<SessionEvent, { kind: "security-assessed" }> => event.kind === "security-assessed")
    .slice(-8)
    .reverse();

  const vm = buildSecurityAuditViewModel({ events: securityEvents, debug: options.debug });
  return renderer.render(vm);
}

async function maybeHandleApprovalGate(input: {
  runtime: Runtime;
  prompt: (question: string) => Promise<string>;
  output: NodeJS.WritableStream;
  renderer: { render(viewModel: import("../contracts/view-model.js").ViewModel): string };
  chrome: PromptChromeController;
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
    const allowPersistentApproval = input.runtime.revokeApproval !== undefined;
    const answer = (await input.prompt(await renderApprovalPrompt(execution, input.renderer, input.chrome, input.output, allowPersistentApproval))).trim().toLowerCase();
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
  renderer: { render(viewModel: import("../contracts/view-model.js").ViewModel): string };
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
    const vm = buildSetupNeededViewModel({
      capability: setup.capability,
      provider: setup.provider,
      model: typeof setup.model === "string" ? setup.model : undefined,
      requiredSecret: setup.requiredSecret,
    });
    return {
      handled: true,
      message: input.renderer.render(vm)
    };
  }

  const provider = setup.provider === "byteplus" ? "byteplus" : "fal";
  const model = typeof setup.model === "string" && setup.model.length > 0
    ? setup.model
    : defaultImageModel(provider);
  const requiredSecret = setup.requiredSecret;

  const vm = buildSetupNeededViewModel({
    capability: "image_generation",
    provider,
    model,
    requiredSecret,
  });
  input.output.write(input.renderer.render(vm));
  input.output.write("\n\n");

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

async function renderApprovalPrompt(
  execution: ToolExecutionRecord,
  renderer: { render(viewModel: import("../contracts/view-model.js").ViewModel): string },
  chrome: PromptChromeController,
  output: NodeJS.WritableStream,
  allowPersistentApproval: boolean
): Promise<string> {
  const vm = buildApprovalPromptViewModel(execution, { allowPersistentApproval });
  chrome.clearInlineSpinner();
  const cardText = renderer.render(vm);
  if (chrome.enabled) {
    await chrome.suspendChromeForTranscript(() => {
      output.write(`${cardText}\n`);
    });
  } else {
    output.write(`${cardText}\n`);
  }
  return "approval > ";
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
  activityBuilder: ToolActivityViewModelBuilder,
  renderer: { render(viewModel: import("../contracts/view-model.js").ViewModel): string },
  streamState: { lastWriteEndedWithNewline: boolean },
  chrome: PromptChromeController | undefined,
  turnOutput: { spinnerPhase?: string; hasOutput: boolean; lastOutputWasSpinner: boolean }
): string | undefined {
  function safeWrite(text: string): void {
    const endsWithNewline = text.endsWith("\n");
    // If the last write didn't end with a newline and this write doesn't
    // start with one, we need to create a boundary to avoid interleaving
    // into an active provider-token stream.
    if (!streamState.lastWriteEndedWithNewline && !text.startsWith("\n")) {
      output.write("\n");
    }
    output.write(text);
    streamState.lastWriteEndedWithNewline = endsWithNewline;
    if (text.length > 0) {
      turnOutput.hasOutput = true;
      turnOutput.lastOutputWasSpinner = false;
    }
  }

  function clearActiveSpinnerLine(): void {
    if (chrome?.enabled) {
      chrome.clearInlineSpinner();
      return;
    }
    if (turnOutput.spinnerPhase !== undefined && turnOutput.lastOutputWasSpinner) {
      output.write(`\x1b[1A\x1b[2K\r`);
    }
    turnOutput.spinnerPhase = undefined;
    turnOutput.lastOutputWasSpinner = false;
  }

  switch (event.kind) {
    case "agent-start":
      if (!chrome?.enabled) {
        safeWrite(`thinking: ${event.input}\n`);
      }
      return "thinking";
    case "intent":
      if (!chrome?.enabled) {
        safeWrite(`intent: ${event.labels.join(", ")} (${Math.round(event.confidence * 100)}%)\n`);
      }
      return "routing";
    case "skill":
      if (!chrome?.enabled) {
        safeWrite(`\u2625 skill: ${event.name}\n`);
      }
      return undefined;
    case "tool-start": {
      clearActiveSpinnerLine();
      const vm = activityBuilder.buildTimelineEvent(event);
      safeWrite(`${renderer.render({ kind: "timeline", events: [vm] })}\n`);
      return "tool";
    }
    case "tool-result": {
      clearActiveSpinnerLine();
      const vm = activityBuilder.buildTimelineEvent(event);
      safeWrite(`${renderer.render({ kind: "timeline", events: [vm] })}\n`);
      return "tool";
    }
    case "provider-attempt":
      if (!chrome?.enabled) {
        safeWrite(event.fallback
          ? `provider: switching to ${event.provider}/${event.model}\n`
          : `provider: using ${event.provider}/${event.model}\n`);
      }
      return "provider";
    case "provider-token": {
      if (!chrome?.enabled) {
        // Provider tokens stream directly; never inject newlines here.
        output.write(event.text);
        if (event.text.length > 0) {
          turnOutput.hasOutput = true;
          turnOutput.lastOutputWasSpinner = false;
        }
        streamState.lastWriteEndedWithNewline = event.text.endsWith("\n");
      }
      return "provider";
    }
    case "provider-tool-call":
      clearActiveSpinnerLine();
      safeWrite(`\n${toolIcon(event.name ?? "")} provider requested ${event.name ?? "unknown"}\n`);
      return "tool";
    case "provider-result":
      if (!chrome?.enabled) {
        if (event.ok) {
          safeWrite(`\nprovider: ${event.provider}/${event.model} ready\n`);
        } else {
          safeWrite(event.willFallback
            ? `\nprovider: ${humanProviderIssue(event.errorClass)} on ${event.provider}/${event.model}; trying fallback\n`
            : `\nprovider: ${humanProviderIssue(event.errorClass)} on ${event.provider}/${event.model}\n`);
        }
      }
      return event.ok || !event.willFallback ? "finalizing" : "provider";
    case "provider-budget-exhausted":
      clearActiveSpinnerLine();
      safeWrite(`\nprovider budget: ${event.reason}\n`);
      return undefined;
    case "agent-cancelled":
      clearActiveSpinnerLine();
      safeWrite(`\ncancelled: ${event.reason}\n`);
      return undefined;
    case "agent-final":
      return undefined;
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

function buildPromptChromeState(
  runtime: Runtime,
  renderer: SessionRenderer,
  activeSpinner?: import("../contracts/view-model.js").ActiveTurnSpinnerViewModel
) {
  const modelInfo = typeof runtime.getModelInfo === "function" ? runtime.getModelInfo() : undefined;
  const modelId = modelInfo?.kind === "kv"
    ? String(modelInfo.entries.find((e) => e.key === "model")?.value ?? "unknown")
    : "unknown";
  const contextWindow = modelInfo?.kind === "kv"
    ? Number(modelInfo.entries.find((e) => e.key === "context window")?.value)
    : Number.NaN;

  return {
    statusRail: buildSessionStatusRailViewModel({
      modelLabel: modelId,
      turnState: "idle",
      contextUsage: Number.isFinite(contextWindow) && contextWindow > 0
        ? { filled: 0, total: contextWindow }
        : undefined,
    }),
    activeSpinner,
  };
}

export function renderHorizontalRule(tokens: ResolvedTokens, useColor: boolean, useUnicode: boolean, width: number): string {
  const ruleChar = useUnicode ? "─" : "-";
  const ruleLen = Math.max(0, width);
  const rule = ruleChar.repeat(ruleLen);
  if (!useColor) return rule;
  return ansiColor(rule, tokens.contract.surface.borderSubtle);
}

export function colorPromptPrefix(prefix: string, tokens: ResolvedTokens, useColor: boolean): string {
  if (!useColor) return prefix;
  return ansiColor(prefix, tokens.contract.palette.action);
}

function ansiColor(text: string, hex: string): string {
  const { r, g, b } = hexToRgb(hex);
  return `\x1B[38;2;${r};${g};${b}m${text}\x1B[0m`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace("#", "");
  const bigint = Number.parseInt(clean, 16);
  return {
    r: (bigint >> 16) & 255,
    g: (bigint >> 8) & 255,
    b: bigint & 255,
  };
}
