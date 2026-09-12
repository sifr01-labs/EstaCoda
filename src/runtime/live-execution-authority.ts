import {assertProfileApplySettled} from '../config/profile-write-lock.js';
import { presentEnvSecretNames } from "../config/env-secret-store.js";
import { validateOAuthStore } from "../providers/oauth/oauth-store.js";
import { stableJsonHash } from "./runtime-fingerprint.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceTrustStore } from "../security/workspace-trust-store.js";

type Check = () => void | Promise<void>;
type Operation = { checks: Set<Check>; borrowers: number; settled: boolean; release(): void };
type Authority = { check(): Promise<void>; checks: Set<Check>; operation?: Operation; onOperation?(work: Promise<unknown>): void };
const active = new AsyncLocalStorage<Authority>();
const references = new WeakMap<Set<Check>, Map<Check, number>>();
export function withExecutionAuthority<T>(check: () => Promise<void>, checks: Set<Check>, work: () => T, onOperation?: Authority["onOperation"]): T {
  return active.run({ check, checks, onOperation }, work);
}
export async function validateCurrentExecutionAuthority(): Promise<void> { await active.getStore()?.check(); }
/** Track actual settlement, even if a caller stops awaiting an aborted tool. */
export function withExecutionOperation<T>(work: () => Promise<T>): Promise<T> {
  const parent = active.getStore();
  if (!parent) return work();
  const counts = references.get(parent.checks) ?? new Map<Check, number>();
  references.set(parent.checks, counts);
  const operation: Operation = { checks: new Set(), borrowers: 0, settled: false, release() {
    if (!operation.settled || operation.borrowers) return;
    for (const check of operation.checks) {
      const count = (counts.get(check) ?? 1) - 1;
      if (count) counts.set(check, count);
      else { counts.delete(check); parent.checks.delete(check); }
    }
    operation.checks.clear();
  } };
  const running = Promise.resolve().then(() => active.run({ ...parent, operation }, work))
    .finally(async () => {
      try { await parent.check(); }
      finally { operation.settled = true; operation.release(); }
    });
  parent.onOperation?.(running);
  return running;
}
/** Background commands keep their originating approval checks until OS cleanup. */
export function retainCurrentExecutionOperation(): () => void {
  const operation = active.getStore()?.operation;
  if (!operation) return () => undefined;
  operation.borrowers++;
  let released = false;
  return () => { if (!released) { released = true; operation.borrowers--; operation.release(); } };
}
export function retainExecutionAuthority(check: Check): void {
  const state = active.getStore();
  if (!state?.operation || state.operation.checks.has(check)) return;
  if (state.checks.size >= 1024) throw new Error("Too many simultaneous execution authorities; settle active work first.");
  state.operation.checks.add(check);
  const counts = references.get(state.checks)!;
  counts.set(check, (counts.get(check) ?? 0) + 1);
  state.checks.add(check);
}
async function governance(profileRoot: string): Promise<string> {
  await assertProfileApplySettled(profileRoot);
  let config: Record<string, unknown> = {};
  try {
    const path = join(profileRoot, "config.json");
    if ((await stat(path)).size > 1_048_576) throw new Error("Profile configuration exceeds validation limit.");
    config = JSON.parse(await readFile(path, "utf8"));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

  return stableJsonHash({ execution: config.execution, security: config.security, tools: config.tools, mcp: config.mcp,
    browser: config.browser, web: config.web });
}
export async function createLiveAuthority(input: { profileRoot: string; workspaceRoot: string; trustStore: WorkspaceTrustStore }): Promise<() => Promise<void>> {
  const revision = await governance(input.profileRoot);
  const credentialPresence = async () => {
    const read = async (name: string): Promise<string> => {
      try {
        const path = join(input.profileRoot, name);
        if ((await stat(path)).size > 1_048_576) throw new Error("Credential state exceeds validation limit.");
        return await readFile(path, "utf8");
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
    };
    const names = presentEnvSecretNames(await read(".env"));
    const auth = await read("auth.json");
    if (auth.trim()) {
      let parsed: unknown;
      try { parsed = JSON.parse(auth); } catch { parsed = {}; }
      const { store } = validateOAuthStore(parsed);
      for (const [id, credential] of Object.entries(store.providers)) {
        if (credential.accessToken.trim()) names.push(`@oauth:${id}:${credential.authMethod}`);
      }
    }
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
