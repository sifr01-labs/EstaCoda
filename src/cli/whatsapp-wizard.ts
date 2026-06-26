import { resolveHomeDir } from "../config/home-dir.js";
import { readActiveProfile } from "../config/profile-home.js";
import {
  runWhatsAppSetupFlow,
  type WhatsAppPairDeviceOptions,
  type WhatsAppPairDeviceResult,
  type WhatsAppSetupDependencies,
  type WhatsAppSetupResult,
} from "../setup/whatsapp-setup-flow.js";
import type { Prompt } from "./prompt-contract.js";

export type WhatsAppWizardResult = WhatsAppSetupResult;
export type { WhatsAppPairDeviceOptions, WhatsAppPairDeviceResult };

export type WhatsAppWizardDependencies = WhatsAppSetupDependencies;

export type WhatsAppWizardOptions = {
  workspaceRoot: string;
  homeDir?: string;
  profileId?: string;
  prompt?: Prompt;
  output?: { write(chunk: string): void };
  dependencies?: WhatsAppWizardDependencies;
};

export async function runWhatsAppWizard(options: WhatsAppWizardOptions): Promise<WhatsAppWizardResult> {
  const homeDir = resolveHomeDir(options.homeDir);
  const profileId = options.profileId ?? readActiveProfile({ homeDir }).profileId ?? "default";
  return runWhatsAppSetupFlow({
    workspaceRoot: options.workspaceRoot,
    homeDir,
    profileId,
    prompt: options.prompt,
    output: options.output,
    dependencies: options.dependencies,
    source: "cli",
  });
}
