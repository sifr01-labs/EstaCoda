import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { diagnoseProviderConfig, diagnoseProviderLive } from "../src/config/provider-diagnostics.js";
import { loadRuntimeConfig, setupProviderConfig, type LoadedRuntimeConfig } from "../src/config/runtime-config.js";
import { defaultProfileId, readActiveProfile, resolveProfileStateHome } from "../src/config/profile-home.js";
import type { ProviderId } from "../src/contracts/provider.js";
import type { RuntimeEvent } from "../src/contracts/runtime-event.js";
import { createRuntime } from "../src/runtime/create-runtime.js";
import { kemetBlueTheme } from "../src/theme/kemet-blue.js";

type ProviderSpec = {
  provider: ProviderId;
  model: string;
  apiKeyEnv?: string;
  optional?: boolean;
};

type ProviderResult = {
  provider: string;
  model: string;
  envPresent: boolean;
  configured: boolean;
  doctorStatus: "ready" | "warning" | "blocked";
  liveStatus: "ready" | "blocked";
  textPromptOk: boolean;
  fileWorkflowOk: boolean;
  warnings: string[];
  artifacts: string[];
};

type PromptExecution = {
  responseText: string;
  tools: string[];
  events: RuntimeEvent[];
  fallbackUsed: boolean;
  responseProvider?: string;
  responseModel?: string;
};

const workspaceRoot = process.cwd();
const profileId = readActiveProfile().profileId ?? defaultProfileId();
const profileConfigPath = resolveProfileStateHome({ profileId }).configPath;
const timestamp = formatTimestamp(new Date());
const runRoot = join(workspaceRoot, ".estacoda", "provider-hardening-runs", timestamp);
const logsDir = join(runRoot, "logs");
const artifactsDir = join(runRoot, "artifacts");
const summaryPath = join(runRoot, "summary.json");
const notesPath = join(runRoot, "notes.md");

const providers: ProviderSpec[] = [
  { provider: "kimi", model: "kimi-k2.5", apiKeyEnv: "KIMI_API_KEY" },
  { provider: "openai", model: "gpt-4.1-mini", apiKeyEnv: "OPENAI_API_KEY" },
  { provider: "deepseek", model: "deepseek-chat", apiKeyEnv: "DEEPSEEK_API_KEY" },
  { provider: "openrouter", model: process.env.ESTACODA_OPENROUTER_MODEL ?? "qwen/qwen3.6-plus", apiKeyEnv: "OPENROUTER_API_KEY" },
  { provider: "local", model: "ollama/auto", optional: true }
];

const originalProfileConfig = await readOptional(profileConfigPath);

await mkdir(logsDir, { recursive: true });
await mkdir(artifactsDir, { recursive: true });

const results: ProviderResult[] = [];

try {
  for (const spec of providers) {
    results.push(await runProvider(spec));
  }
} finally {
  await restoreProfileConfig(originalProfileConfig);
}

await writeFile(summaryPath, `${JSON.stringify({
  createdAt: new Date().toISOString(),
  workspaceRoot,
  runRoot,
  results
}, null, 2)}\n`, "utf8");
await writeFile(notesPath, renderNotes(results), "utf8");

console.log([
  "EstaCoda provider hardening batch completed.",
  `Run root: ${runRoot}`,
  `Summary: ${summaryPath}`,
  `Notes: ${notesPath}`,
  "",
  ...results.map((result) =>
    `${result.provider}/${result.model}: doctor=${result.doctorStatus} live=${result.liveStatus} text=${flag(result.textPromptOk)} file=${flag(result.fileWorkflowOk)}`
  )
].join("\n"));

async function runProvider(spec: ProviderSpec): Promise<ProviderResult> {
  const envPresent = spec.apiKeyEnv === undefined ? true : typeof process.env[spec.apiKeyEnv] === "string" && process.env[spec.apiKeyEnv] !== "";
  const result: ProviderResult = {
    provider: spec.provider,
    model: spec.model,
    envPresent,
    configured: false,
    doctorStatus: "blocked",
    liveStatus: "blocked",
    textPromptOk: false,
    fileWorkflowOk: false,
    warnings: [],
    artifacts: []
  };

  if (!envPresent && spec.optional !== true) {
    result.warnings.push(`Missing ${spec.apiKeyEnv}.`);
    await writeProviderLog(spec.provider, {
      skipped: true,
      reason: `missing ${spec.apiKeyEnv}`
    });
    return result;
  }

  await setupProviderConfig({
    workspaceRoot,
    input: {
      provider: spec.provider,
      model: spec.model,
      apiKeyEnv: spec.apiKeyEnv,
      scope: "project"
    }
  });
  result.configured = true;

  const config = await loadRuntimeConfig({ workspaceRoot, profileId });
  const providerDiagnostic = await diagnoseProviderConfig(config);
  const liveDiagnostic = await diagnoseProviderLive(config);
  result.doctorStatus = providerDiagnostic.status;
  result.liveStatus = liveDiagnostic.status;
  result.warnings.push(...providerDiagnostic.warnings, ...liveDiagnostic.warnings);

  const log: Record<string, unknown> = {
    providerDiagnostic,
    liveDiagnostic
  };

  if (liveDiagnostic.status !== "ready") {
    await writeProviderLog(spec.provider, log);
    return result;
  }

  const runtime = await buildRuntime(config);
  await runtime.trustWorkspace();

  const textPrompt = `Reply in one short sentence confirming that the active provider is ${spec.provider}/${spec.model}.`;
  const textExecution = await runPrompt(runtime, textPrompt);
  log.textExecution = textExecution;
  result.textPromptOk = !textExecution.fallbackUsed &&
    textExecution.responseProvider === spec.provider &&
    includesProviderLabel(textExecution.responseText, spec);
  const textArtifact = join(artifactsDir, `${spec.provider}-text.txt`);
  await writeFile(textArtifact, `${textExecution.responseText}\n`, "utf8");
  result.artifacts.push(textArtifact);

  if (textExecution.fallbackUsed) {
    result.warnings.push(`Text prompt used fallback provider ${textExecution.responseProvider ?? "unknown"}/${textExecution.responseModel ?? "unknown"}.`);
  }

  const fileTarget = join(artifactsDir, `${spec.provider}-roundtrip.md`);
  const marker = `${spec.provider}/${spec.model} roundtrip proof`;
  const filePrompt = [
    `Create a file at ${fileTarget} containing exactly: ${marker}.`,
    "Then read it back and confirm the exact contents."
  ].join(" ");
  const fileExecution = await runPrompt(runtime, filePrompt);
  log.fileExecution = fileExecution;
  result.fileWorkflowOk = !fileExecution.fallbackUsed &&
    fileExecution.responseProvider === spec.provider &&
    fileExecution.tools.includes("file.write") &&
    fileExecution.tools.includes("file.read") &&
    (await fileContains(fileTarget, marker));
  result.artifacts.push(fileTarget);

  if (fileExecution.fallbackUsed) {
    result.warnings.push(`File workflow used fallback provider ${fileExecution.responseProvider ?? "unknown"}/${fileExecution.responseModel ?? "unknown"}.`);
  } else if (fileExecution.responseProvider === spec.provider && fileExecution.tools.length === 0 && fileExecution.responseText.trim().length === 0) {
    result.warnings.push("File workflow returned an empty successful response with no tool calls.");
  } else if (fileExecution.responseText.trim().length === 0) {
    result.warnings.push("File workflow succeeded through tools/artifact checks, but the final assistant text was empty.");
  }

  await writeProviderLog(spec.provider, log);
  return result;
}

async function buildRuntime(config: LoadedRuntimeConfig) {
  return createRuntime({
    theme: kemetBlueTheme,
    workspaceRoot,
    model: config.model,
    externalSkillRoots: config.skills.externalDirs,
    skillConfig: config.skills.config,
    providerRegistry: config.providerRegistry,
    auxiliaryProviders: config.auxiliaryProviders,
    browser: config.browser,
    telegramReady: config.channels.telegram.ready,
    enableWebNetwork: config.web.enableNetwork,
    webMaxContentChars: config.web.maxContentChars
  });
}

async function runPrompt(
  runtime: Awaited<ReturnType<typeof buildRuntime>>,
  text: string
): Promise<PromptExecution> {
  const events: RuntimeEvent[] = [];
  const response = await runtime.handle({
    channel: "cli",
    text,
    trustedWorkspace: true,
    onEvent(event) {
      events.push(event);
    }
  });

  return {
    responseText: response.text,
    tools: response.toolExecutions.map((execution) => execution.tool.name),
    events,
    fallbackUsed: response.providerExecution?.fallbackUsed === true,
    responseProvider: response.providerExecution?.response?.provider,
    responseModel: response.providerExecution?.response?.model
  };
}

function includesProviderLabel(text: string, spec: ProviderSpec): boolean {
  const haystack = text.toLowerCase();
  return haystack.includes(spec.provider.toLowerCase()) || haystack.includes(spec.model.toLowerCase());
}

async function writeProviderLog(provider: string, payload: unknown): Promise<void> {
  await writeFile(join(logsDir, `${provider}.json`), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function restoreProfileConfig(original: string | undefined): Promise<void> {
  if (original === undefined) {
    await rm(profileConfigPath, { force: true });
    return;
  }

  await writeFile(profileConfigPath, original, "utf8");
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function fileContains(path: string, expected: string): Promise<boolean> {
  try {
    return (await readFile(path, "utf8")).trim() === expected;
  } catch {
    return false;
  }
}

function renderNotes(results: ProviderResult[]): string {
  return [
    "# Provider Hardening Batch",
    "",
    `- Workspace: ${workspaceRoot}`,
    `- Run root: ${runRoot}`,
    "",
    "## Summary",
    "",
    "| Provider | Doctor | Live | Text Prompt | File Workflow | Notes |",
    "| --- | --- | --- | --- | --- | --- |",
    ...results.map((result) => `| ${result.provider}/${result.model} | ${result.doctorStatus} | ${result.liveStatus} | ${flag(result.textPromptOk)} | ${flag(result.fileWorkflowOk)} | ${escapePipes(result.warnings.join("; ") || "-")} |`),
    "",
    "## Follow-ups",
    "",
    "- Compare latency and tool-call behavior across providers.",
    "- Note any provider that only passes doctor/live checks but fails the file workflow.",
    "- Treat local/Ollama as optional until operator proof is collected."
  ].join("\n");
}

function flag(value: boolean): string {
  return value ? "pass" : "fail";
}

function escapePipes(value: string): string {
  return value.replaceAll("|", "\\|");
}

function formatTimestamp(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  const hour = String(value.getHours()).padStart(2, "0");
  const minute = String(value.getMinutes()).padStart(2, "0");
  const second = String(value.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hour}${minute}${second}`;
}
