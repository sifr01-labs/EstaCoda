import { writeEnvSecret } from "../config/env-secret-store.js";

export type CapabilitySetupKind = "image_generation" | "voice" | "web_search" | "browser" | "mcp";

export type SetupNeededMetadata = {
  kind: "setup_needed";
  capability: CapabilitySetupKind;
  providerOptions: string[];
  requiredSecret: string;
  resumeIntent: string;
  suggestedCommand: string;
  suggestedTool: string;
  provider?: string;
  model?: string;
};

export type CapabilitySecretSetupResult = {
  envName: string;
  secretPath: string;
};

export function setupNeeded(input: SetupNeededMetadata): SetupNeededMetadata {
  return input;
}

export async function storeCapabilitySecret(options: {
  homeDir?: string;
  envName: string;
  secret: string;
}): Promise<CapabilitySecretSetupResult> {
  const result = await writeEnvSecret({
    homeDir: options.homeDir,
    key: options.envName,
    value: options.secret
  });
  process.env[result.key] = options.secret;

  return {
    envName: result.key,
    secretPath: result.path
  };
}
