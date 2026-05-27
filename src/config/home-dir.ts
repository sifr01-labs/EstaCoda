import { homedir } from "node:os";

export function resolveHomeDir(explicit?: string): string {
  return explicit ?? process.env.ESTACODA_HOME ?? process.env.HOME ?? homedir() ?? "";
}

export function resolveOsHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME ?? env.USERPROFILE ?? homedir() ?? "";
}
