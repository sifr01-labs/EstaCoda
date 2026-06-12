import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, constants, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, join, relative, resolve } from "node:path";
import { HttpWhatsAppBridgeClient } from "../channels/whatsapp-bridge-client.js";
import { WhatsAppBridgeRuntimeError } from "../channels/whatsapp-bridge-errors.js";
import {
  defaultWhatsAppBridgeDir,
  getWhatsAppBridgeDependencyStatus,
  installWhatsAppBridgeDependencies,
  type WhatsAppBridgeDependencyStatus,
} from "../channels/whatsapp-bridge-lifecycle.js";
import {
  loadRuntimeConfig,
  setupWhatsAppConfig,
  type UiLanguage,
  type WhatsAppChannelMode,
  type WhatsAppDmPolicy,
} from "../config/runtime-config.js";
import { resolveProfileStateHome } from "../config/profile-home.js";
import { resolveSetupCopy, type SetupCopyKey } from "./setup-copy.js";

const DEFAULT_QR_TIMEOUT_MS = 120_000;
const WHATSAPP_AUTH_DIR_NAME = "whatsapp-auth";

export type WhatsAppSetupSource = "cli" | "setup-editor" | "onboarding";

export type WhatsAppSetupPrompt = {
  (question: string): Promise<string>;
};

export type WhatsAppSetupOutput = {
  write(chunk: string): void;
};

export type WhatsAppSetupResult = {
  handled: true;
  exitCode: number;
  output: string;
  failureReason?: WhatsAppSetupFailureReason;
};

export type WhatsAppSetupFailureReason =
  | "dependency_declined"
  | "dependency_failed"
  | "repair_declined"
  | "invalid_mode"
  | "pairing_timeout"
  | "pairing_failed";

export type WhatsAppPairDeviceOptions = {
  authDir: string;
  bridgeDir: string;
  timeoutMs: number;
  output: WhatsAppSetupOutput;
};

export type WhatsAppPairDeviceResult =
  | { ok: true }
  | { ok: false; reason: "timeout" | "failed"; message?: string };

export type WhatsAppSetupDependencies = {
  getDependencyStatus?: (options: { bridgeDir?: string }) => Promise<WhatsAppBridgeDependencyStatus>;
  installDependencies?: typeof installWhatsAppBridgeDependencies;
  pairDevice?: (options: WhatsAppPairDeviceOptions) => Promise<WhatsAppPairDeviceResult>;
};

export type WhatsAppSetupFlowOptions = {
  workspaceRoot: string;
  homeDir: string;
  profileId: string;
  prompt?: WhatsAppSetupPrompt;
  output?: WhatsAppSetupOutput;
  dependencies?: WhatsAppSetupDependencies;
  source: WhatsAppSetupSource;
  locale?: UiLanguage;
};

type ResolvedWhatsAppSetupCopy = {
  introBlock: string;
  dependenciesMissingQuestion: string;
  dependenciesReady: string;
  dependenciesDeclined: string;
  dependenciesFailed(message: string): string;
  repairQuestion: string;
  repairDeclined: string;
  modeBlock: string;
  modeInvalid: string;
  modeSelectedDedicated: string;
  modeSelectedPersonal: string;
  dedicatedGuidance: string;
  personalGuidance: string;
  allowlistQuestion: string;
  allowlistSelected(allowedSenders: string): string;
  allowlistEmpty: string;
  pairingInstructions: string;
  pairingBlock(authDir: string): string;
  pairingTimeout: string;
  pairingFailed(message: string): string;
  successLinked: string;
  successSessionSaved: string;
  successRestricted(allowedSenders: string): string;
  successPairingPending: string;
  successReady: string;
  cancelled: string;
};

export async function runWhatsAppSetupFlow(options: WhatsAppSetupFlowOptions): Promise<WhatsAppSetupResult> {
  const paths = resolveProfileStateHome({ homeDir: options.homeDir, profileId: options.profileId });
  const loaded = await loadRuntimeConfig({
    workspaceRoot: options.workspaceRoot,
    homeDir: options.homeDir,
    profileId: options.profileId
  });
  const locale = options.locale ?? (loaded.ui.language === "ar" ? "ar" : "en");
  const copy = setupFlowCopy(locale);
  const lines: string[] = [];
  const write = (chunk: string) => {
    if (options.output !== undefined) {
      options.output.write(chunk);
    } else {
      lines.push(chunk.endsWith("\n") ? chunk.slice(0, -1) : chunk);
    }
  };
  const say = (line = "") => lines.push(line);

  say(copy.introBlock);
  say("");

  const deps = options.dependencies ?? {};
  const bridgeDir = defaultWhatsAppBridgeDir();
  const getDependencyStatus = deps.getDependencyStatus ?? getWhatsAppBridgeDependencyStatus;
  const installDependencies = deps.installDependencies ?? installWhatsAppBridgeDependencies;
  const pairDevice = deps.pairDevice ?? pairDeviceWithForegroundBridge;
  const dependencyStatus = await getDependencyStatus({ bridgeDir });
  if (dependencyStatus.missing.length > 0) {
    if (!yes(await ask(options.prompt, copy.dependenciesMissingQuestion))) {
      say(copy.dependenciesDeclined);
      return finish(1, lines, [], "dependency_declined");
    }
    try {
      await installDependencies({ bridgeDir, logPath: join(paths.logsPath, "whatsapp-bridge-install.log") });
    } catch (error) {
      say(copy.dependenciesFailed(installErrorMessage(error)));
      return finish(1, lines, [], "dependency_failed");
    }
  }

  const authDir = loaded.channels.whatsapp.authDir ?? join(paths.gatewayStatePath, WHATSAPP_AUTH_DIR_NAME);
  const hasExistingWhatsAppConfig = loaded.config.channels?.whatsapp?.enabled === true
    || loaded.config.channels?.whatsapp?.authDir !== undefined;
  const state = hasExistingWhatsAppConfig ? await detectPairingState(authDir) : "fresh";
  if (state !== "fresh") {
    if (!yes(await ask(options.prompt, copy.repairQuestion))) {
      say(copy.repairDeclined);
      return finish(1, lines, [], "repair_declined");
    }
    await clearProfileLocalAuthDir(authDir, paths.gatewayStatePath);
  }

  const mode = normalizeMode(await ask(options.prompt, copy.modeBlock));
  if (mode === undefined) {
    say(copy.modeInvalid);
    return finish(1, lines, [], "invalid_mode");
  }
  say(mode === "bot" ? copy.modeSelectedDedicated : copy.modeSelectedPersonal);
  say(mode === "bot" ? copy.dedicatedGuidance : copy.personalGuidance);
  say("");

  const allowedUsers = normalizeAllowedUsers(await ask(options.prompt, copy.allowlistQuestion));
  const dmPolicy: WhatsAppDmPolicy = allowedUsers.length > 0 ? "allowlist" : "pairing";

  if (allowedUsers.length > 0) {
    say(copy.allowlistSelected(allowedUsers.join(", ")));
  } else {
    say(copy.allowlistEmpty);
  }
  say(copy.dependenciesReady);
  say("");
  say(copy.pairingInstructions);
  say("");
  say(copy.pairingBlock(authDir));
  const qrOutput: string[] = [];
  const pairResult = await pairDevice({
    authDir,
    bridgeDir,
    timeoutMs: DEFAULT_QR_TIMEOUT_MS,
    output: {
      write: (chunk) => {
        if (options.output === undefined) qrOutput.push(chunk);
        write(chunk);
      },
    },
  });
  if (!pairResult.ok) {
    say(pairResult.reason === "timeout" ? copy.pairingTimeout : copy.pairingFailed(pairResult.message ?? "unknown error"));
    return finish(1, lines, [], pairResult.reason === "timeout" ? "pairing_timeout" : "pairing_failed");
  }

  await setupWhatsAppConfig({
    workspaceRoot: options.workspaceRoot,
    homeDir: options.homeDir,
    profileId: options.profileId,
    input: {
      enabled: true,
      experimental: true,
      authDir,
      allowedUsers,
      mode,
      dmPolicy,
      pairingMode: "qr",
    },
  });
  say(copy.successLinked);
  say(copy.successSessionSaved);
  if (dmPolicy === "pairing") {
    say(copy.successPairingPending);
  } else {
    say(copy.successRestricted(allowedUsers.join(", ")));
  }
  say("");
  say(copy.successReady);
  return finish(0, lines, qrOutput);
}

function setupFlowCopy(locale: UiLanguage): ResolvedWhatsAppSetupCopy {
  const token = (key: SetupCopyKey) => resolveSetupCopy(locale, key);
  const format = (key: SetupCopyKey, values: Record<string, string>) => {
    let value = token(key);
    for (const [name, replacement] of Object.entries(values)) {
      value = value.replaceAll(`{${name}}`, replacement);
    }
    return value;
  };
  return {
    introBlock: token("whatsappWizard.intro.block"),
    dependenciesMissingQuestion: token("whatsappWizard.dependencies.missingQuestion"),
    dependenciesReady: token("whatsappWizard.dependencies.ready"),
    dependenciesDeclined: token("whatsappWizard.dependencies.declined"),
    dependenciesFailed: (message) => format("whatsappWizard.dependencies.failed", { message }),
    repairQuestion: token("whatsappWizard.repair.question"),
    repairDeclined: token("whatsappWizard.repair.declined"),
    modeBlock: token("whatsappWizard.mode.block"),
    modeInvalid: token("whatsappWizard.mode.invalid"),
    modeSelectedDedicated: token("whatsappWizard.mode.selectedDedicated"),
    modeSelectedPersonal: token("whatsappWizard.mode.selectedPersonal"),
    dedicatedGuidance: token("whatsappWizard.dedicated.guidance"),
    personalGuidance: token("whatsappWizard.personal.guidance"),
    allowlistQuestion: token("whatsappWizard.allowlist.question"),
    allowlistSelected: (allowedSenders) => format("whatsappWizard.allowlist.selected", { allowedSenders }),
    allowlistEmpty: token("whatsappWizard.allowlist.empty"),
    pairingInstructions: token("whatsappWizard.pairing.instructions"),
    pairingBlock: (authDir) => format("whatsappWizard.pairing.block", { authDir }),
    pairingTimeout: token("whatsappWizard.pairing.timeout"),
    pairingFailed: (message) => format("whatsappWizard.pairing.failed", { message }),
    successLinked: token("whatsappWizard.success.linked"),
    successSessionSaved: token("whatsappWizard.success.sessionSaved"),
    successRestricted: (allowedSenders) => format("whatsappWizard.success.restricted", { allowedSenders }),
    successPairingPending: token("whatsappWizard.success.pairingPending"),
    successReady: token("whatsappWizard.success.ready"),
    cancelled: token("whatsappWizard.cancelled"),
  };
}

async function ask(prompt: WhatsAppSetupPrompt | undefined, question: string): Promise<string | undefined> {
  if (prompt === undefined) return undefined;
  return prompt(question);
}

function finish(
  exitCode: number,
  lines: string[],
  qrOutput: string[] = [],
  failureReason?: WhatsAppSetupFailureReason
): WhatsAppSetupResult {
  const output = [...qrOutput, lines.join("\n")].filter((part) => part.length > 0).join(qrOutput.length > 0 ? "\n" : "");
  return failureReason === undefined
    ? { handled: true, exitCode, output }
    : { handled: true, exitCode, output, failureReason };
}

function yes(value: string | undefined): boolean {
  return /^(y|yes|نعم|ن)$/iu.test((value ?? "").trim());
}

function normalizeMode(value: string | undefined): WhatsAppChannelMode | undefined {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "1" || normalized === "bot" || normalized === "dedicated") return "bot";
  if (normalized === "self" || normalized === "personal" || normalized === "self-chat") return "self-chat";
  if (normalized === "2") return "self-chat";
  return undefined;
}

function normalizeAllowedUsers(value: string | undefined): string[] {
  return Array.from(new Set((value ?? "")
    .split(/[,\s]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)));
}

async function detectPairingState(authDir: string): Promise<"fresh" | "not_paired" | "logged_out"> {
  if (!await canRead(join(authDir, "creds.json"))) return "not_paired";
  try {
    const state = JSON.parse(await readFile(join(authDir, "bridge-state.json"), "utf8")) as { baseUrl?: string; token?: string };
    if (typeof state.baseUrl === "string" && typeof state.token === "string") {
      const health = await new HttpWhatsAppBridgeClient({ baseUrl: state.baseUrl, token: state.token, requestTimeoutMs: 1_000 }).getHealth();
      if (health.status === "logged_out" || health.error?.code === "whatsapp_logged_out") return "logged_out";
    }
  } catch {
    // A stale or absent bridge state should not force a reset when credentials exist.
  }
  return "fresh";
}

async function clearProfileLocalAuthDir(authDir: string, gatewayStatePath: string): Promise<void> {
  const gatewayRoot = resolve(gatewayStatePath);
  const expectedAuthDir = resolve(gatewayRoot, WHATSAPP_AUTH_DIR_NAME);
  const targetAuthDir = resolve(authDir);
  if (targetAuthDir !== expectedAuthDir) {
    throw new Error("Refusing to clear anything except the selected profile WhatsApp auth directory.");
  }
  const realGatewayRoot = await realpathOrUndefined(gatewayRoot);
  const realTargetAuthDir = await realpathOrUndefined(targetAuthDir);
  if (realGatewayRoot !== undefined && realTargetAuthDir !== undefined) {
    if (realTargetAuthDir === realGatewayRoot || !isPathInside(realGatewayRoot, realTargetAuthDir)) {
      throw new Error("Refusing to clear WhatsApp authDir outside the selected profile gateway state directory.");
    }
  }
  await rm(targetAuthDir, { recursive: true, force: true });
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function realpathOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

async function pairDeviceWithForegroundBridge(options: WhatsAppPairDeviceOptions): Promise<WhatsAppPairDeviceResult> {
  await mkdir(options.authDir, { recursive: true });
  const token = randomBytes(32).toString("hex");
  const port = await reserveLoopbackPort();
  const child = spawn(process.execPath, [
    join(options.bridgeDir, "bridge.js"),
    "--auth-dir", options.authDir,
    "--host", "127.0.0.1",
    "--port", String(port),
    "--pair-only",
  ], {
    cwd: options.bridgeDir,
    env: { ...process.env, ESTACODA_WHATSAPP_BRIDGE_TOKEN: token },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  }) as unknown as ChildProcessWithoutNullStreams;
  const startedAt = Date.now();
  try {
    const ready = waitForPairBridgeReady(child, options.output, options.timeoutMs);
    await ready;
    const client = new HttpWhatsAppBridgeClient({ baseUrl: `http://127.0.0.1:${port}`, token, requestTimeoutMs: 1_000 });
    while (Date.now() - startedAt < options.timeoutMs) {
      try {
        const health = await client.getHealth();
        if (health.status === "connected" && await canRead(join(options.authDir, "creds.json"))) {
          return { ok: true };
        }
      } catch {
        // Keep polling until timeout; QR pairing can take a few seconds after socket start.
      }
      await sleep(1_000);
    }
    return { ok: false, reason: "timeout" };
  } catch (error) {
    if (Date.now() - startedAt >= options.timeoutMs) return { ok: false, reason: "timeout" };
    return { ok: false, reason: "failed", message: error instanceof Error ? error.message : String(error) };
  } finally {
    await terminateChild(child);
  }
}

function waitForPairBridgeReady(
  child: ChildProcessWithoutNullStreams,
  output: WhatsAppSetupOutput,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("WhatsApp QR pairing timed out."))), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output.write(text);
      if (text.includes("ESTACODA_WHATSAPP_BRIDGE_READY")) finish(resolve);
    });
    child.stderr.on("data", (chunk: Buffer) => output.write(chunk.toString("utf8")));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("exit", (code, signal) => finish(() => reject(new Error(`WhatsApp bridge exited during pairing (${code ?? signal ?? "unknown"}).`))));
  });
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : undefined;
      server.close(() => port === undefined ? reject(new Error("Unable to reserve WhatsApp bridge port.")) : resolve(port));
    });
    server.on("error", reject);
  });
}

async function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  }
  await sleep(250);
  if (child.exitCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch { /* ignore */ }
}

function installErrorMessage(error: unknown): string {
  if (error instanceof WhatsAppBridgeRuntimeError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

async function canRead(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
