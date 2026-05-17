#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { loadRuntimeConfig, type LoadedRuntimeConfig } from "./config/runtime-config.js";
import { resolveStateHome } from "./config/state-home.js";
import { defaultProfileId, readActiveProfile } from "./config/profile-home.js";
import { PersistentCliSessionStore } from "./cli/cli-session-store.js";
import { parseGlobalCliOptions, runCliCommand } from "./cli/cli.js";
import type { SessionDB } from "./contracts/session.js";
import { canRunInteractive } from "./cli/readline-prompt.js";
import { createRuntime } from "./runtime/create-runtime.js";
import { runSessionLoop, handleSlashCommand } from "./cli/session-loop.js";
import { runOneShotPrompt } from "./cli/one-shot.js";
import { WorkspaceApprovalController } from "./security/workspace-approval-controller.js";
import { WorkspaceTrustStore } from "./security/workspace-trust-store.js";
import { resolveTokens } from "./theme/token-resolver.js";
import { launchInteractiveSession } from "./cli/interactive-launcher.js";
import { getPackageVersion } from "./cli/version-command.js";
import { renderPlain } from "./ui/renderers/plain-renderer.js";
import type { UiLocale } from "./contracts/ui.js";
import { createSQLiteSessionDB } from "./session/session-setup.js";

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  const initialArgv = rawArgv[0] === "--" ? rawArgv.slice(1) : rawArgv;
  const parsedGlobalOptions = parseGlobalCliOptions(initialArgv);
  if (!parsedGlobalOptions.ok) {
    console.error(parsedGlobalOptions.error);
    process.exit(1);
  }
  const argv = parsedGlobalOptions.argv;

  // Handle --version / -v immediately, before any async init
  if (argv.includes("--version") || argv.includes("-v")) {
    const version = await getPackageVersion();
    console.log(`estacoda ${version}`);
    process.exit(0);
  }

  let workspaceRoot = process.cwd();

  if (isSideEffectFreeHelp(argv)) {
    const helpCommand = await runCliCommand({
      argv,
      workspaceRoot,
      profileId: parsedGlobalOptions.profileId
    });

    if (helpCommand.handled) {
      if (helpCommand.output.length > 0) {
        console.log(helpCommand.output);
      }
      process.exit(helpCommand.exitCode);
    }
  }

  const cliSessionStore = new PersistentCliSessionStore();
  const cliApprovalController = new WorkspaceApprovalController();
  let launchLocale: UiLocale | undefined;

  const stateHome = resolveStateHome();
  const profileId = parsedGlobalOptions.profileId ?? readActiveProfile()?.profileId ?? defaultProfileId();
  const trustStore = new WorkspaceTrustStore({ path: stateHome.trustJsonPath });
  let workspaceTrusted = await trustStore.isTrusted(workspaceRoot);

  if (argv[0] === "setup") {
    const setupCommand = await runCliCommand({
      argv,
      workspaceRoot,
      profileId
    });

    if (setupCommand.handled) {
      if (setupCommand.output.length > 0) {
        console.log(setupCommand.output);
      }
      process.exit(setupCommand.exitCode);
    }
  }

  if (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    const helpCommand = await runCliCommand({
      argv,
      workspaceRoot,
      profileId
    });

    if (helpCommand.handled) {
      if (helpCommand.output.length > 0) {
        console.log(helpCommand.output);
      }
      process.exit(helpCommand.exitCode);
    }
  }

  if (canDispatchBeforeRuntime(argv)) {
    const command = await runCliCommand({
      argv,
      workspaceRoot,
      profileId,
      output: {
        write: (chunk) => process.stdout.write(chunk)
      }
    });

    if (command.handled) {
      if (command.output.length > 0) {
        console.log(command.output);
      }
      process.exit(command.exitCode);
    }
  }

  // Bare launch: use interactive launcher for onboarding/session routing
  if (argv.length === 0 && canRunInteractive()) {
    const launchResult = await launchInteractiveSession({ workspaceRoot, profileId });

    if (!launchResult.launched) {
      if (launchResult.output.length > 0) {
        console.log(launchResult.output);
      }
      process.exit(launchResult.exitCode);
    }

    if (launchResult.workspaceRoot !== undefined) {
      workspaceRoot = launchResult.workspaceRoot;
    }
    launchLocale = launchResult.locale;

    if (launchResult.onboardingTriggered) {
      workspaceTrusted = await trustStore.isTrusted(workspaceRoot);
    }
  }

  let config: LoadedRuntimeConfig;
  try {
    config = await loadRuntimeConfig({ workspaceRoot, profileId });
  } catch (error) {
    if (argv[0] === "doctor" || argv[0] === "verify") {
      const diagnosticCommand = await runCliCommand({
        argv,
        workspaceRoot,
        profileId
      });

      if (diagnosticCommand.handled) {
        if (diagnosticCommand.output.length > 0) {
          console.log(diagnosticCommand.output);
        }
        process.exit(diagnosticCommand.exitCode);
      }
    }

    throw error;
  }

  async function buildRuntime(input: {
    sessionId?: string;
    sessionDb?: SessionDB;
  } = {}) {
    const nowTrusted = await trustStore.isTrusted(workspaceRoot);
    const latestConfig = await loadRuntimeConfig({ workspaceRoot, profileId });

    return createRuntime({
      tokens: resolveTokens("standard", "dark", "kemetBlue"),
      model: latestConfig.model,
      primaryModelRoute: latestConfig.primaryModelRoute,
      modelFallbackRoutes: latestConfig.modelFallbackRoutes,
      profileId,
      workspaceRoot,
      sessionId: input.sessionId,
      sessionDb: input.sessionDb,
      externalSkillRoots: latestConfig.skills.externalDirs,
      skillAutonomy: latestConfig.skills.autonomy,
      skillConfig: latestConfig.skills.config,
      ui: latestConfig.ui,
      agentProfile: latestConfig.profile,
      providerRegistry: latestConfig.providerRegistry,
      auxiliaryModels: latestConfig.auxiliaryModels,
      mcpServers: latestConfig.mcp.servers,
      browser: latestConfig.browser,
      imageGen: latestConfig.imageGen,
      tts: latestConfig.tts,
      stt: latestConfig.stt,
      telegramReady: latestConfig.channels.telegram.ready,
      enableWebNetwork: latestConfig.web.enableNetwork,
      webMaxContentChars: latestConfig.web.maxContentChars,
      securityMode: latestConfig.security.approvalMode,
      securityAssessor: latestConfig.security.assessor,
      approvalController: cliApprovalController,
      workspaceTrusted: nowTrusted
    });
  }

  async function openLocalSessionDb(): Promise<SessionDB> {
    return createSQLiteSessionDB({ path: stateHome.sessionsSqlitePath });
  }

  if (argv[0] === "acp") {
    const acpCommand = await runCliCommand({
      argv,
      workspaceRoot,
      profileId
    });

    if (acpCommand.handled) {
      if (acpCommand.output.length > 0) {
        console.log(acpCommand.output);
      }
      process.exit(acpCommand.exitCode);
    }
  }

  const sessionDb = await openLocalSessionDb();

  const runtime = await buildRuntime({
    sessionId: await cliSessionStore.getSessionId(workspaceRoot),
    sessionDb
  });
  await cliSessionStore.setSessionId(workspaceRoot, runtime.sessionId);

  const command = await runCliCommand({
    argv,
    workspaceRoot,
    profileId,
    tools: runtime.tools(),
    runtime
  });

  if (command.handled) {
    console.log(command.output);
    await runtime.dispose();
    process.exit(command.exitCode);
  }

  if (argv.length === 0 && canRunInteractive()) {
    await runSessionLoop({
      runtime,
      workspaceRoot,
      locale: launchLocale ?? (config.ui.language === "ar" ? "ar" : "en"),
      refreshRuntime: async (options) => {
        const nextRuntime = await buildRuntime({
          sessionId: options?.preserveSession === true ? runtime.sessionId : randomUUID(),
          sessionDb: await openLocalSessionDb()
        });
        await cliSessionStore.setSessionId(workspaceRoot, nextRuntime.sessionId);
        return nextRuntime;
      },
      switchRuntime: async (sessionId) => {
        const nextRuntime = await buildRuntime({
          sessionId,
          sessionDb: await openLocalSessionDb()
        });
        await cliSessionStore.setSessionId(workspaceRoot, nextRuntime.sessionId);
        return nextRuntime;
      }
    });
    await runtime.dispose();
    process.exit(0);
  }

  if (argv.length >= 1 && argv[0].startsWith("/")) {
    const chunks: string[] = [];
    const output = {
      write: (chunk: string | Buffer) => { chunks.push(String(chunk)); },
      end: () => {}
    } as NodeJS.WritableStream;

    const result = await handleSlashCommand({
      text: argv.join(" "),
      runtime,
      output,
      renderer: { render: renderPlain },
      workspaceRoot
    });

    if (typeof result !== "boolean") {
      chunks.push(result.notice(runtime));
    }

    console.log(chunks.join(""));
    await runtime.dispose();
    process.exit(0);
  }

  const ONE_SHOT_TIMEOUT_MS = 30_000;

  const oneShot = await Promise.race([
    runOneShotPrompt({
      runtime,
      argv
    }),
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`One-shot prompt timed out after ${ONE_SHOT_TIMEOUT_MS}ms. The provider may be unresponsive.`));
      }, ONE_SHOT_TIMEOUT_MS);
    })
  ]).catch((error) => {
    return {
      handled: true,
      exitCode: 1,
      output: `Error: ${error instanceof Error ? error.message : String(error)}`
    } as Awaited<ReturnType<typeof runOneShotPrompt>>;
  });

  if (oneShot.handled) {
    if (oneShot.output.length > 0) {
      console.log(oneShot.output);
    }
    await runtime.dispose();
    process.exit(oneShot.exitCode);
  }

  console.log(runtime.describe());
  console.log(`config sources: ${config.sources.join(", ") || "none"}`);
  await runtime.dispose();
}

function canDispatchBeforeRuntime(argv: readonly string[]): boolean {
  const command = argv[0];
  if (command === undefined || command.startsWith("/")) {
    return false;
  }
  return new Set([
    "browser",
    "channels",
    "curator",
    "doctor",
    "eval",
    "evolution",
    "flow",
    "gateway",
    "handoff",
    "image",
    "init",
    "knowledge",
    "local",
    "manifest",
    "mcp",
    "model",
    "packs",
    "profile",
    "proposal",
    "security",
    "sessions",
    "settings",
    "skills",
    "telegram",
    "trace",
    "update",
    "verify",
    "voice",
    "web"
  ]).has(command);
}

function isSideEffectFreeHelp(argv: readonly string[]): boolean {
  if (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    return true;
  }
  return argv.includes("--help") || argv.includes("-h");
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
