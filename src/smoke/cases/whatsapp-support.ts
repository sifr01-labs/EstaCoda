import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { SmokeCase } from "../smoke-case.js";
import { resolveProfileStateHome } from "../../config/profile-home.js";
import { readConfig } from "../../config/runtime-config.js";
import {
  runWhatsAppWizard,
  type WhatsAppPairDeviceOptions,
  type WhatsAppWizardDependencies,
} from "../../cli/whatsapp-wizard.js";
import { WhatsAppAdapter } from "../../channels/whatsapp-adapter.js";
import type { WhatsAppBridgeInboundMessage } from "../../channels/whatsapp-bridge-client.js";
import type { Prompt } from "../../cli/prompt-contract.js";
import { ChannelGateway, InMemoryChannelSessionStore } from "../../channels/channel-gateway.js";
import type { Runtime } from "../../runtime/create-runtime.js";

export const whatsapp_support_case: SmokeCase = {
  id: "whatsapp-support",
  name: "WhatsApp wizard, docs boundary, and package quarantine smoke",
  tags: ["gateway", "whatsapp", "package"],
  run: async () => {
    assertRootPackageBoundary();

    const tempRoot = await mkdtemp(join(tmpdir(), "estacoda-smoke-whatsapp-"));
    try {
      await assertDeclinedInstallLeavesConfigUnchanged(join(tempRoot, "decline"));
      await assertCancellationLeavesConfigUnchanged(join(tempRoot, "cancel"));
      await assertSuccessfulSetupWritesOnlyExpectedKeys(join(tempRoot, "success"));
      await assertFakeBridgeInboundImageReachesRuntime(join(tempRoot, "inbound-image"));
      await assertFakeBridgeRapidTextsDebounce(join(tempRoot, "debounce"));
      await assertArabicWizardCopyPreservesTechnicalTokens(join(tempRoot, "arabic"));
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
};

function assertRootPackageBoundary(): void {
  const rootPackage = JSON.parse(readFileSync("package.json", "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    files?: string[];
  };
  const bridgePackage = JSON.parse(readFileSync("scripts/whatsapp-bridge/package.json", "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const rootDeps = {
    ...(rootPackage.dependencies ?? {}),
    ...(rootPackage.devDependencies ?? {}),
  };
  for (const dependency of ["@whiskeysockets/baileys", "@hapi/boom"]) {
    if (dependency in rootDeps) {
      throw new Error(`Root package must not depend on ${dependency}`);
    }
    if (!(dependency in (bridgePackage.dependencies ?? {}))) {
      throw new Error(`Bridge package must own ${dependency}`);
    }
  }

  const files = new Set(rootPackage.files ?? []);
  const expectedBridgeFiles = [
    "scripts/whatsapp-bridge/package.json",
    "scripts/whatsapp-bridge/package-lock.json",
    "scripts/whatsapp-bridge/bridge.js",
    "scripts/whatsapp-bridge/README.md",
  ];
  for (const file of expectedBridgeFiles) {
    if (!files.has(file)) {
      throw new Error(`Root package files must include ${file}`);
    }
  }
  if ([...files].some((file) => file.startsWith("scripts/whatsapp-bridge/node_modules"))) {
    throw new Error("Root package files must not include bridge node_modules");
  }
}

async function assertFakeBridgeInboundImageReachesRuntime(homeDir: string): Promise<void> {
  const mediaRoot = join(homeDir, "profile", "channel-media");
  const inboundRoot = join(mediaRoot, "whatsapp", "inbound");
  const imagePath = join(inboundRoot, "photo.jpg");
  await mkdir(inboundRoot, { recursive: true });
  await writeFile(imagePath, "photo", "utf8");
  const messages: WhatsAppBridgeInboundMessage[] = [{
    messageId: "image-1",
    chatId: "971501234567@s.whatsapp.net",
    senderId: "971501234567@s.whatsapp.net",
    body: "caption",
    attachments: [{
      id: "photo-1",
      kind: "image",
      status: "ready",
      mimeType: "image/jpeg",
      localPath: imagePath,
      bytes: 5,
    }],
  }];
  const adapter = new WhatsAppAdapter({
    authDir: join(homeDir, "gateway", "whatsapp-auth"),
    mediaRoot,
    experimental: true,
    bridgeClient: {
      start: async () => undefined,
      stop: async () => undefined,
      getHealth: async () => ({ ok: true, apiVersion: "whatsapp-bridge.v1", status: "connected" }),
      pollMessages: async () => messages.splice(0, messages.length),
      sendText: async () => ({ ok: true }),
      editMessage: async () => ({ ok: true }),
      sendMedia: async () => ({ ok: true }),
      sendTyping: async () => ({ ok: true }),
      getChat: async (chatId: string) => ({ id: chatId }),
    },
  });
  let receivedAttachment = false;
  await adapter.start(async (message) => {
    receivedAttachment = message.attachments?.[0]?.kind === "image" &&
      message.attachments[0].status === "ready" &&
      message.attachments[0].localPath !== undefined &&
      message.text === "caption";
  });
  await adapter.pollOnce();
  await adapter.stop();
  if (!receivedAttachment) {
    throw new Error("Fake WhatsApp bridge image attachment did not reach the runtime handler");
  }
}

async function assertFakeBridgeRapidTextsDebounce(homeDir: string): Promise<void> {
  const messages: WhatsAppBridgeInboundMessage[] = [
    {
      messageId: "text-1",
      chatId: "971501234567@s.whatsapp.net",
      senderId: "971501234567@s.whatsapp.net",
      body: "first",
    },
    {
      messageId: "text-2",
      chatId: "971501234567@s.whatsapp.net",
      senderId: "971501234567@s.whatsapp.net",
      body: "second",
    }
  ];
  const adapter = new WhatsAppAdapter({
    authDir: join(homeDir, "gateway", "whatsapp-auth"),
    mediaRoot: join(homeDir, "profile", "channel-media"),
    experimental: true,
    bridgeClient: {
      start: async () => undefined,
      stop: async () => undefined,
      getHealth: async () => ({ ok: true, apiVersion: "whatsapp-bridge.v1", status: "connected" }),
      pollMessages: async () => {
        const next = messages.shift();
        return next === undefined ? [] : [next];
      },
      sendText: async () => ({ ok: true }),
      editMessage: async () => ({ ok: true }),
      sendMedia: async () => ({ ok: true }),
      sendTyping: async () => ({ ok: true }),
      getChat: async (chatId: string) => ({ id: chatId }),
    },
  });
  const runtimeTexts: string[] = [];
  const gateway = new ChannelGateway({
    adapters: [adapter],
    runtimeForSession: async () => ({
      handle: async (input: Parameters<Runtime["handle"]>[0]) => {
        runtimeTexts.push(input.text);
        return {
          label: "ok",
          text: "ok",
          matchedSkills: [],
          intent: { labels: ["general"], confidence: 1, nativeIntent: "general", suggestedToolsets: [], suggestedSkills: [], confirmationRequired: false, evidence: [], rationale: "" },
          securityDecision: "allow",
          toolExecutions: [],
          toolPlans: [],
          skillOutcomes: [],
          artifacts: [],
          context: undefined,
          projectContext: undefined,
          progress: []
        };
      },
      dispose: async () => undefined,
    }) as unknown as Runtime,
    sessionStore: new InMemoryChannelSessionStore(),
    authPolicy: { whatsapp: { dmPolicy: "open" } },
    whatsappTextDebounce: {
      textDebounceMs: 10,
      textDebounceMaxMessages: 10,
      textDebounceMaxChars: 8_000
    }
  });
  await gateway.start();
  await adapter.pollOnce();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await adapter.pollOnce();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await gateway.stop();

  if (runtimeTexts.length !== 1 || runtimeTexts[0] !== "first\n\nsecond") {
    throw new Error(`Fake WhatsApp bridge rapid texts were not debounced into one runtime turn: ${JSON.stringify(runtimeTexts)}`);
  }
}

async function assertDeclinedInstallLeavesConfigUnchanged(homeDir: string): Promise<void> {
  await mkdir(homeDir, { recursive: true });
  const deps = missingBridgeDeps();
  const result = await runWhatsAppWizard({
    workspaceRoot: homeDir,
    homeDir,
    prompt: fakePrompt(["n"]),
    dependencies: deps,
  });
  if (result.exitCode === 0 || !result.output.includes("Config was not changed")) {
    throw new Error(`Expected declined install to cancel without config mutation, got: ${result.output}`);
  }
  if (await configLoaded(homeDir)) {
    throw new Error("Declined bridge dependency install must not create profile config");
  }
}

async function assertCancellationLeavesConfigUnchanged(homeDir: string): Promise<void> {
  await mkdir(homeDir, { recursive: true });
  let pairAttempts = 0;
  const installedDeps = installedBridgeDeps();
  const result = await runWhatsAppWizard({
    workspaceRoot: homeDir,
    homeDir,
    prompt: fakePrompt(["cancel"]),
    dependencies: {
      ...installedDeps,
      pairDevice: async (options) => {
        pairAttempts += 1;
        return installedDeps.pairDevice?.(options) ?? { ok: true };
      },
    },
  });
  if (result.exitCode === 0 || result.failureReason !== "invalid_mode") {
    throw new Error(`Expected wizard cancellation before QR pairing, got: ${result.output}`);
  }
  if (pairAttempts !== 0) {
    throw new Error(`Cancelled WhatsApp wizard must not start QR pairing, got ${pairAttempts} attempt(s)`);
  }
  if (await configLoaded(homeDir)) {
    throw new Error("Cancelled WhatsApp wizard must not create profile config");
  }
}

async function assertSuccessfulSetupWritesOnlyExpectedKeys(homeDir: string): Promise<void> {
  await mkdir(homeDir, { recursive: true });
  const result = await runWhatsAppWizard({
    workspaceRoot: homeDir,
    homeDir,
    prompt: fakePrompt(["bot", "971501234567"]),
    dependencies: installedBridgeDeps(),
  });
  if (result.exitCode !== 0) {
    throw new Error(`Expected WhatsApp setup success, got: ${result.output}`);
  }

  const config = await readConfig(resolveProfileStateHome({ homeDir, profileId: "default" }).configPath);
  const whatsapp = config.config.channels?.whatsapp as Record<string, unknown> | undefined;
  const expectedKeys = [
    "allowedGroups",
    "allowedUsers",
    "authDir",
    "dmPolicy",
    "enabled",
    "experimental",
    "freeResponseChats",
    "groupPolicy",
    "mentionPatterns",
    "mode",
    "pairingMode",
    "replyPrefix",
  ];
  if (whatsapp === undefined) throw new Error("WhatsApp config was not written");
  if (JSON.stringify(Object.keys(whatsapp).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error(`Unexpected WhatsApp config keys: ${Object.keys(whatsapp).sort().join(", ")}`);
  }
  if (whatsapp.dmPolicy !== "allowlist" || whatsapp.mode !== "bot") {
    throw new Error(`Unexpected WhatsApp config policy/mode: ${JSON.stringify(whatsapp)}`);
  }
}

async function assertArabicWizardCopyPreservesTechnicalTokens(homeDir: string): Promise<void> {
  const paths = resolveProfileStateHome({ homeDir, profileId: "default" });
  await mkdir(dirname(paths.configPath), { recursive: true });
  await writeFile(paths.configPath, JSON.stringify({ ui: { language: "ar" } }), "utf8");

  const result = await runWhatsAppWizard({
    workspaceRoot: homeDir,
    homeDir,
    prompt: fakePrompt(["cancel"]),
    dependencies: installedBridgeDeps(),
  });
  if (result.failureReason !== "invalid_mode") {
    throw new Error(`Arabic WhatsApp wizard cancellation should fail before pairing, got: ${result.output}`);
  }
  for (const token of ["WhatsApp", "estacoda whatsapp"]) {
    if (!result.output.includes(token)) {
      throw new Error(`Arabic WhatsApp wizard output must preserve ${token}`);
    }
  }
}

function fakePrompt(answers: string[]): Prompt {
  return (async () => answers.shift() ?? "") as Prompt;
}

function missingBridgeDeps(): WhatsAppWizardDependencies {
  return {
    getDependencyStatus: async () => ({
      bridgeDir: "/tmp/bridge",
      packagePresent: true,
      lockfilePresent: true,
      entrypointPresent: true,
      nodeModulesPresent: false,
      missing: ["node_modules"],
    }),
    installDependencies: async () => undefined,
    pairDevice: async () => ({ ok: true }),
  };
}

function installedBridgeDeps(): WhatsAppWizardDependencies {
  return {
    getDependencyStatus: async () => ({
      bridgeDir: "/tmp/bridge",
      packagePresent: true,
      lockfilePresent: true,
      entrypointPresent: true,
      nodeModulesPresent: true,
      missing: [],
    }),
    installDependencies: async () => undefined,
    pairDevice: async (options: WhatsAppPairDeviceOptions) => {
      await mkdir(options.authDir, { recursive: true });
      await writeFile(join(options.authDir, "creds.json"), "{}\n", "utf8");
      return { ok: true };
    },
  };
}

async function configLoaded(homeDir: string): Promise<boolean> {
  return (await readConfig(resolveProfileStateHome({ homeDir, profileId: "default" }).configPath)).loaded;
}
