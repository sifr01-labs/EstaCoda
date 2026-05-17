import type { ProviderId } from "../contracts/provider.js";
import { writeEnvSecret, type EnvSecretWriteResult } from "../config/env-secret-store.js";
import { defaultProfileId, readActiveProfile } from "../config/profile-home.js";
import type { Prompt } from "./readline-prompt.js";

export type PromptForApiKeyResult =
  | { kind: "stored"; envVarName: string; envPath: string }
  | { kind: "skipped"; envVarName: string };

export type PromptForApiKeyInputResult =
  | { kind: "entered"; envVarName: string; value: string }
  | { kind: "skipped"; envVarName: string };

export async function promptForApiKeyInput(options: {
  prompt: Prompt;
  providerId: ProviderId;
  envVarName: string;
  question?: string;
}): Promise<PromptForApiKeyInputResult> {
  const question = options.question ?? `Enter API key for ${options.providerId}: `;
  const raw = (await options.prompt(question, { secret: true })).trim();

  if (raw.length === 0) {
    return { kind: "skipped", envVarName: options.envVarName };
  }

  return { kind: "entered", envVarName: options.envVarName, value: raw };
}

export async function promptForApiKey(options: {
  prompt: Prompt;
  providerId: ProviderId;
  envVarName: string;
  homeDir?: string;
  profileId?: string;
  question?: string;
}): Promise<PromptForApiKeyResult> {
  const input = await promptForApiKeyInput(options);

  if (input.kind === "skipped") {
    return { kind: "skipped", envVarName: options.envVarName };
  }

  const result: EnvSecretWriteResult = await writeEnvSecret({
    homeDir: options.homeDir,
    profileId: options.profileId ?? readActiveProfile({ homeDir: options.homeDir }).profileId ?? defaultProfileId(),
    key: options.envVarName,
    value: input.value,
  });

  return { kind: "stored", envVarName: result.key, envPath: result.path };
}

export function maskSecret(value: string): string {
  if (value.length <= 8) {
    return "****";
  }
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}

const DEFAULT_REDACT_KEYS = [
  /apiKey/i,
  /api[_-]?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /credential/i,
  /auth/i,
  /private[_-]?key/i,
];

export function redactInObject(
  value: unknown,
  keyMatchers?: RegExp[]
): unknown {
  const matchers = keyMatchers ?? DEFAULT_REDACT_KEYS;

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactInObject(item, matchers));
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      const shouldRedact = matchers.some((m) => m.test(key));
      result[key] = shouldRedact && typeof val === "string" ? maskSecret(val) : redactInObject(val, matchers);
    }
    return result;
  }

  return value;
}
