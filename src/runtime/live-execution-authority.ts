import { stableJsonHash } from "./runtime-fingerprint.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceTrustStore } from "../security/workspace-trust-store.js";

const active = new AsyncLocalStorage<{ check(): Promise<void>; checks: Set<() => void | Promise<void>> }>();
export function withExecutionAuthority<T>(check: () => Promise<void>, checks: Set<() => void | Promise<void>>, work: () => T): T {
  return active.run({ check, checks }, work);
}
export async function validateCurrentExecutionAuthority(): Promise<void> { await active.getStore()?.check(); }
export function retainExecutionAuthority(check: () => void | Promise<void>): void {
  const checks = active.getStore()?.checks;
  if (!checks) return;
  if (checks.size >= 1024) throw new Error("Execution authority tracking is full; settle and reacquire the runtime.");
  checks.add(check);
}
async function governance(profileRoot: string): Promise<string> {
  let config: Record<string, unknown> = {};
  try {
    const path = join(profileRoot, "config.json");
    if ((await stat(path)).size > 1_048_576) throw new Error("Profile configuration exceeds validation limit.");
    config = JSON.parse(await readFile(path, "utf8"));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

  return stableJsonHash({ security: config.security, tools: config.tools, mcp: config.mcp,
    browser: config.browser, web: config.web });
}
export async function createLiveAuthority(input: { profileRoot: string; workspaceRoot: string; trustStore: WorkspaceTrustStore }): Promise<() => Promise<void>> {
  const revision = await governance(input.profileRoot);
  const credentialPresence = async () => {
    let names: string[] = [];
    try { names = [...(await readFile(join(input.profileRoot, ".env"), "utf8")).matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map((entry) => entry[1]); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { await stat(join(input.profileRoot, "auth.json")); names.push("@oauth-store"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return new Set(names);
  };
  const credentialNames = await credentialPresence();
  let previouslyTrusted = await input.trustStore.isTrusted(input.workspaceRoot);
  return async () => {
    const currentCredentials = await credentialPresence();
    if ([...credentialNames].some((name) => !currentCredentials.has(name))) throw new Error("Profile credential availability changed; reacquire before continuing.");
    const trusted = await input.trustStore.isTrusted(input.workspaceRoot);
    if (previouslyTrusted && !trusted) throw new Error("Workspace trust was revoked.");
    previouslyTrusted ||= trusted;
    if (await governance(input.profileRoot) !== revision) throw new Error("Runtime security or credential configuration changed; reacquire before continuing.");
  };
}
