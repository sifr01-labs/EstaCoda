#!/usr/bin/env node
import { resolveHomeDir } from "./config/home-dir.js";
import { loadRuntimeConfig, type LoadedRuntimeConfig } from "./config/runtime-config.js";
import { resolveStateHome } from "./config/state-home.js";
import { defaultProfileId, readActiveProfile, resolveProfileStateHome } from "./config/profile-home.js";
import { PersistentCliSessionStore } from "./cli/cli-session-store.js";
import { parseGlobalCliOptions, runCliCommand } from "./cli/cli.js";
import type { SessionDB } from "./contracts/session.js";
import { canRunInteractive } from "./ui/terminal-capabilities.js";
import { createRuntime } from "./runtime/create-runtime.js";
import { runSessionLoop, handleSlashCommand } from "./cli/session-loop.js";
import { detectTaskBackgroundHost } from "./cli/task-commands.js";
import { runOneShotPrompt } from "./cli/one-shot.js";
import type { ModelSwitchContext } from "./providers/model-switch-resolver.js";
import { resolveEffectiveSessionModelOverride } from "./providers/model-switch-resolver.js";
import { WorkspaceApprovalController } from "./security/workspace-approval-controller.js";
import { WorkspaceTrustStore } from "./security/workspace-trust-store.js";
import { resolveTokens } from "./theme/token-resolver.js";
import { launchInteractiveSession } from "./cli/interactive-launcher.js";
import { getPackageVersion } from "./cli/version-command.js";
import { renderPlain } from "./ui/renderers/plain-renderer.js";
import type { UiLocale } from "./contracts/ui.js";
import { createSQLiteSessionDB } from "./session/session-setup.js";
import { scheduleStartupUpdatePrefetch, shouldScheduleStartupUpdatePrefetch } from "./lifecycle/startup-update.js";
import { resolveSetupCopy } from "./setup/setup-copy.js";
import { createSessionId, resolveStartupSessionId } from "./session/session-id.js";
import { GatewayApprovalQueue } from "./gateway/approval-queue.js";
import { ForegroundTaskHost } from "./workflow/foreground-task-host.js";
import { SQLiteTaskStore } from "./workflow/sqlite-task-store.js";
import { TaskApprovalService } from "./workflow/task-approval-service.js";
import { TaskResultService } from "./workflow/task-result-service.js";
import { resolveTaskWorkspaceBinding } from "./workflow/task-workspace.js";

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  const initialArgv = rawArgv[0] === "--" ? rawArgv.slice(1) : rawArgv;
  const parsedGlobalOptions = parseGlobalCliOptions(initialArgv);
  if (!parsedGlobalOptions.ok) {
    console.error(parsedGlobalOptions.error);
    process.exit(1);
  }
  let argv = parsedGlobalOptions.argv;
  const homeDir = resolveHomeDir();

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
      homeDir,
      profileId: parsedGlobalOptions.profileId
    });

    if (helpCommand.handled) {
      if (helpCommand.output.length > 0) {
        console.log(helpCommand.output);
      }
      process.exit(helpCommand.exitCode);
    }
  }

  const stateHome = resolveStateHome({ homeDir });
  const cliSessionStore = new PersistentCliSessionStore({ homeDir: stateHome.homeDir });
  const cliApprovalController = new WorkspaceApprovalController();
  let launchLocale: UiLocale | undefined;

  const profileId = parsedGlobalOptions.profileId ?? readActiveProfile({ homeDir })?.profileId ?? defaultProfileId();
  const trustStore = new WorkspaceTrustStore({ path: stateHome.trustJsonPath });
  let workspaceTrusted = await trustStore.isTrusted(workspaceRoot);
  let setupLaunchHandoffCompleted = false;

  if (argv[0] === "setup") {
    const setupCommand = await runCliCommand({
      argv,
      workspaceRoot,
      homeDir,
      profileId
    });

    if (setupCommand.handled) {
      if (setupCommand.output.length > 0) {
        console.log(setupCommand.output);
      }
      if (setupCommand.launchRequested === true && setupCommand.exitCode === 0) {
        const launchResult = await launchInteractiveSession({ workspaceRoot, homeDir, profileId });
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
        workspaceTrusted = await trustStore.isTrusted(workspaceRoot);
        if (!workspaceTrusted) {
          console.log(resolveSetupCopy(launchLocale ?? "en", "onboarding.workspace.trust.deferredFinal"));
          process.exit(1);
        }
        setupLaunchHandoffCompleted = true;
        argv = [];
      } else {
        process.exit(setupCommand.exitCode);
      }
    }
  }

  if (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    const helpCommand = await runCliCommand({
      argv,
      workspaceRoot,
      homeDir,
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
      homeDir,
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

  // Bare launch: use interactive launcher for setup/session routing
  if (!setupLaunchHandoffCompleted && argv.length === 0 && canRunInteractive()) {
    const launchResult = await launchInteractiveSession({ workspaceRoot, homeDir, profileId });

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
    config = await loadRuntimeConfig({ workspaceRoot, homeDir, profileId });
  } catch (error) {
    if (argv[0] === "doctor" || argv[0] === "verify") {
      const diagnosticCommand = await runCliCommand({
        argv,
        workspaceRoot,
        homeDir,
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

  let foregroundTaskHost: ForegroundTaskHost | undefined;
  const activateForegroundTask = async (taskId: string): Promise<void> => {
    await foregroundTaskHost?.startTask(taskId);
  };

  async function buildRuntime(input: {
    sessionId?: string;
    sessionDb?: SessionDB;
    closeSessionDbOnDispose?: boolean;
    sessionMetadata?: Record<string, unknown>;
  } = {}) {
    const nowTrusted = await trustStore.isTrusted(workspaceRoot);
    const latestConfig = await loadRuntimeConfig({ workspaceRoot, homeDir, profileId });
    const sessionDb = input.sessionDb;
    const storedOverride = input.sessionId !== undefined && sessionDb !== undefined
      ? await sessionDb.getSessionModelOverride(input.sessionId).catch(() => undefined)
      : undefined;
    const effectiveOverride = await resolveEffectiveSessionModelOverride(storedOverride, {
      config: latestConfig.config,
      providerRegistry: latestConfig.providerRegistry
    });
    const effectiveRoute = effectiveOverride?.ok === true ? effectiveOverride.route : latestConfig.primaryModelRoute;
    const effectiveModel = effectiveOverride?.ok === true ? effectiveOverride.route.profile : latestConfig.model;
    const taskBackgroundHost = await detectTaskBackgroundHost({ homeDir, profileId });

    return createRuntime({
      tokens: resolveTokens("standard", "dark", "kemetBlue"),
      model: effectiveModel,
      primaryModelRoute: effectiveRoute,
      modelFallbackRoutes: latestConfig.modelFallbackRoutes,
      homeDir,
      profileId,
      workspaceRoot,
      sessionId: input.sessionId,
      sessionDb,
      closeSessionDbOnDispose: input.closeSessionDbOnDispose,
      sessionMetadata: input.sessionMetadata,
      externalSkillRoots: latestConfig.skills.externalDirs,
      skillAutonomy: latestConfig.skills.autonomy,
      skillConfig: latestConfig.skills.config,
      ui: latestConfig.ui,
      agentProfile: latestConfig.profile,
      providerRegistry: latestConfig.providerRegistry,
      providerConfigs: latestConfig.config.providers,
      auxiliaryModels: latestConfig.auxiliaryModels,
      compression: latestConfig.compression,
      memory: latestConfig.memory,
      externalMemory: latestConfig.externalMemory,
      mcpServers: latestConfig.mcp.servers,
      browser: latestConfig.browser,
      imageGen: latestConfig.imageGen,
      tts: latestConfig.tts,
      stt: latestConfig.stt,
      telegramReady: latestConfig.channels.telegram.ready,
      enableWebNetwork: latestConfig.web.enableNetwork,
      webMaxContentChars: latestConfig.web.maxContentChars,
      webConfig: {
        backend: latestConfig.web.backend,
        searchBackend: latestConfig.web.searchBackend,
        extractBackend: latestConfig.web.extractBackend,
        crawlBackend: latestConfig.web.crawlBackend,
        brave: latestConfig.web.brave
      },
      securityConfig: {
        allowPrivateUrls: latestConfig.security.allowPrivateUrls,
        websiteBlocklist: latestConfig.security.websiteBlocklist
      },
      securityMode: latestConfig.security.approvalMode,
      securityAssessor: latestConfig.security.assessor,
      approvalController: cliApprovalController,
      workspaceTrusted: nowTrusted,
      taskBackgroundContinuation: taskBackgroundHost === "active" ? "available" : "unavailable",
      onTaskCreated: activateForegroundTask
    });
  }

  async function modelSwitchContext(): Promise<ModelSwitchContext> {
    const latestConfig = await loadRuntimeConfig({ workspaceRoot, homeDir, profileId });
    return {
      config: latestConfig.config,
      providerRegistry: latestConfig.providerRegistry
    };
  }

  async function openLocalSessionDb() {
    return createSQLiteSessionDB({ path: stateHome.sessionsSqlitePath });
  }

  if (argv[0] === "acp") {
    const acpCommand = await runCliCommand({
      argv,
      workspaceRoot,
      homeDir,
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
  const restoredSessionId = await cliSessionStore.getSessionId(workspaceRoot);
  const startupSessionId = resolveStartupSessionId(restoredSessionId);

  const runtime = await buildRuntime({
    sessionId: startupSessionId,
    sessionDb
  });
  await cliSessionStore.setSessionId(workspaceRoot, runtime.sessionId);
  if (shouldScheduleStartupUpdatePrefetch(argv, canRunInteractive())) {
    scheduleStartupUpdatePrefetch({
      homeDir: stateHome.homeDir,
      workspaceRoot
    });
  }

  const command = await runCliCommand({
    argv,
    workspaceRoot,
    homeDir,
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
    const foregroundSessionDb = await openLocalSessionDb();
    const foregroundStore = new SQLiteTaskStore({ db: foregroundSessionDb.db, profileId });
    const foregroundApprovalService = new TaskApprovalService({
      store: foregroundStore,
      queue: new GatewayApprovalQueue({
        db: foregroundSessionDb.db,
        controller: cliApprovalController
      })
    });
    const foregroundWorkspace = await resolveTaskWorkspaceBinding(workspaceRoot);
    const profilePaths = resolveProfileStateHome({ homeDir, profileId });
    const host = new ForegroundTaskHost({
      store: foregroundStore,
      resultService: new TaskResultService({
        store: foregroundStore,
        profileId,
        contentRoot: profilePaths.taskResultsPath,
        sessionDb: foregroundSessionDb
      }),
      ownerId: `foreground-task-host-${process.pid}-${Date.now()}`,
      workspaceIdentityHash: foregroundWorkspace.identityHash,
      approvalService: foregroundApprovalService,
      createExecutorRuntime: async () => {
        const executorRuntime = await buildRuntime({
          sessionId: createSessionId(),
          sessionDb: foregroundSessionDb,
          closeSessionDbOnDispose: false,
          sessionMetadata: { kind: "task-foreground-host" }
        });
        const executor = executorRuntime.taskAgentExecutor;
        if (executor === undefined) {
          await executorRuntime.dispose();
          throw new Error("Interactive durable Task executor is unavailable for this runtime.");
        }
        return { executor, dispose: () => executorRuntime.dispose() };
      },
      logWarning: (message) => console.warn(message)
    });
    foregroundTaskHost = host;
    try {
      await host.start();
      await runSessionLoop({
        runtime,
        workspaceRoot,
        locale: launchLocale ?? (config.ui.language === "ar" ? "ar" : "en"),
        showResponseProgress: config.ui.showResponseProgress,
        operatorConsole: { enabled: true },
        taskApprovals: {
          listPending: (authorizedSessionId) => host.listPendingApprovals(authorizedSessionId),
          resolve: async (input) => {
            await host.resolvePendingApproval(input);
          }
        },
        refreshRuntime: async (options) => {
          const nextRuntime = await buildRuntime({
            sessionId: options?.preserveSession === true ? runtime.sessionId : createSessionId(),
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
        },
        modelSwitchContext
      });
    } finally {
      await host.shutdown();
      foregroundTaskHost = undefined;
      foregroundSessionDb.close();
    }
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
      refreshRuntime: async (options) => buildRuntime({
        sessionId: options?.preserveSession === true ? runtime.sessionId : createSessionId(),
        sessionDb: await openLocalSessionDb()
      }),
      modelSwitchContext,
      output,
      renderer: { render: renderPlain },
      workspaceRoot,
      homeDir: stateHome.homeDir
    });

    if (typeof result !== "boolean") {
      chunks.push(result.notice(result.runtime));
    }

    console.log(chunks.join(""));
    if (typeof result !== "boolean" && result.runtime !== runtime) {
      await result.runtime.dispose();
    }
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
    "bench",
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
    "memory",
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
    "whatsapp",
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
