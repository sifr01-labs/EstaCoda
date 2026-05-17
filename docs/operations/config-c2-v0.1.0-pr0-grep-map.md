# Config C2 v0.1.0 PR 0 Grep Map

Audit-only grep map for the Config C2 v0.1.0 overhaul. This file intentionally records tracked-file occurrences only; pre-existing untracked working-tree files are excluded from this map.

## Search

- Source set: `git ls-files`
- Pattern: `\b(mergeConfig|projectConfigTrust|credentialPools|scope|userConfigPath|projectConfigPath)\b`
- Generated file only; no source files were changed.

## Proposed Action Guide

- `delete`: remove the config-merge/project-config/credential-pool behavior or the tests/docs that assert it. For `scope`, delete only when the occurrence represents `user`/`project` setup targeting or CLI plumbing.
- `modify`: replace runtime behavior in place without preserving the old concept; the runtime config loader should become single-profile loading rather than merged loading.
- `rename`: keep the underlying single-file mutation behavior, but rename the API or option to the profile-first concept, such as `patchConfig` or profile config path.
- `keep temporarily`: the occurrence is either unrelated to Config C2, such as command registry scope, approval scope, OAuth scope, taskflow scope, or general prose, or it is staged compatibility that should remain until the checkpoint that removes its callers.

## Adjacent Risks

These are not additional PR 0 targets and are not expanded into the occurrence map, but later checkpoints should explicitly handle them because they can preserve deleted behavior behind neighboring names:

- `loadUserRuntimeConfig` and `loadTrustedRuntimeConfig` are wrapper APIs around the old trust split and should disappear when profile loading replaces user/project config loading.
- `CredentialPool`, `CredentialPoolRegistry`, and `src/providers/credential-pool.ts` can outlive the `credentialPools` field unless provider and diagnostics callsites are removed together.
- `ConfigScope` in onboarding review code aliases the old `user`/`project` target model and should be removed with setup apply/review plumbing.
- CLI flags such as `--project`, `--user`, `--trust`, and `--no-trust` may encode the same old model even when the exact target symbols are not present on the line.

## Counts

| Symbol | Occurrences |
|---|---:|
| `mergeConfig` | 34 |
| `projectConfigTrust` | 103 |
| `credentialPools` | 77 |
| `scope` | 434 |
| `userConfigPath` | 154 |
| `projectConfigPath` | 136 |
| **Total** | **938** |

## mergeConfig

| File | Line | Symbol | Proposed action | Occurrence |
|---|---:|---|---|---|
| `src/config/provider-config-mutations.test.ts` | 17 | `mergeConfig` | rename | `import { setupProviderConfig, loadRuntimeConfig, mergeConfig, type EstaCodaConfig } from "./runtime-config.js";` |
| `src/config/provider-config-mutations.ts` | 9 | `mergeConfig` | rename | `mergeConfig,` |
| `src/config/provider-config-mutations.ts` | 94 | `mergeConfig` | rename | `return mergeConfig(existing, patch);` |
| `src/config/provider-config-mutations.ts` | 132 | `mergeConfig` | rename | `const config = mergeConfig(existing, {` |
| `src/config/provider-config-mutations.ts` | 158 | `mergeConfig` | rename | `return mergeConfig(existing, {` |
| `src/config/provider-config-mutations.ts` | 199 | `mergeConfig` | rename | `return mergeConfig(existing, patch);` |
| `src/config/provider-config-mutations.ts` | 224 | `mergeConfig` | rename | `const merged = mergeConfig(existing, {` |
| `src/config/runtime-config.test.ts` | 5 | `mergeConfig` | rename | `import { loadRuntimeConfig, loadUserRuntimeConfig, loadTrustedRuntimeConfig, mergeConfig, normalizeAuxiliaryModels, saveRuntimeConfig } from "./runtime-config.js";` |
| `src/config/runtime-config.test.ts` | 33 | `mergeConfig` | rename | `describe("mergeConfig auxiliaryModels", () => {` |
| `src/config/runtime-config.test.ts` | 35 | `mergeConfig` | rename | `const merged = mergeConfig(` |
| `src/config/runtime-config.test.ts` | 43 | `mergeConfig` | rename | `const merged = mergeConfig(` |
| `src/config/runtime-config.test.ts` | 52 | `mergeConfig` | rename | `const merged = mergeConfig(` |
| `src/config/runtime-config.test.ts` | 60 | `mergeConfig` | rename | `const merged = mergeConfig(` |
| `src/config/runtime-config.test.ts` | 859 | `mergeConfig` | rename | `const { mergeConfig } = await import("./runtime-config.js");` |
| `src/config/runtime-config.test.ts` | 860 | `mergeConfig` | rename | `const merged = mergeConfig(` |
| `src/config/runtime-config.ts` | 578 | `mergeConfig` | modify | `const config = mergeConfig(...loaded.map((entry) => entry.config));` |
| `src/config/runtime-config.ts` | 743 | `mergeConfig` | rename | `export function mergeConfig(...configs: EstaCodaConfig[]): EstaCodaConfig {` |
| `src/config/runtime-config.ts` | 1482 | `mergeConfig` | rename | `const config = mergeConfig(existing.config, {` |
| `src/config/runtime-config.ts` | 1514 | `mergeConfig` | rename | `const merged = mergeConfig(existing.config, {` |
| `src/config/runtime-config.ts` | 1559 | `mergeConfig` | rename | `const config = mergeConfig(existing.config, {` |
| `src/config/runtime-config.ts` | 1596 | `mergeConfig` | rename | `const config = mergeConfig(existing.config, {` |
| `src/config/runtime-config.ts` | 1624 | `mergeConfig` | rename | `const config = mergeConfig(existing.config, {` |
| `src/config/runtime-config.ts` | 1653 | `mergeConfig` | rename | `const config = mergeConfig(existing.config, {` |
| `src/config/runtime-config.ts` | 1683 | `mergeConfig` | rename | `const config = mergeConfig(existing.config, {` |
| `src/config/runtime-config.ts` | 1747 | `mergeConfig` | rename | `const config = mergeConfig(existing.config, {` |
| `src/config/runtime-config.ts` | 1810 | `mergeConfig` | rename | `const config = mergeConfig(existing.config, {` |
| `src/config/runtime-config.ts` | 1879 | `mergeConfig` | rename | `const config = mergeConfig(existing.config, {` |
| `src/config/runtime-config.ts` | 1923 | `mergeConfig` | rename | `const config = mergeConfig(existing.config, {` |
| `src/config/runtime-config.ts` | 1951 | `mergeConfig` | rename | `const config = mergeConfig(existing.config, {` |
| `src/config/runtime-config.ts` | 1982 | `mergeConfig` | rename | `const config = mergeConfig(existing.config, {` |
| `src/config/runtime-config.ts` | 2021 | `mergeConfig` | rename | `const config = mergeConfig(existing.config, {` |
| `src/config/runtime-config.ts` | 2093 | `mergeConfig` | rename | `const config = mergeConfig(existing.config, {` |
| `src/config/runtime-config.ts` | 2132 | `mergeConfig` | rename | `const config = mergeConfig(existing.config, {` |
| `src/config/runtime-config.ts` | 2203 | `mergeConfig` | rename | `const config = mergeConfig(existing.config, {` |

## projectConfigTrust

| File | Line | Symbol | Proposed action | Occurrence |
|---|---:|---|---|---|
| `scripts/provider-hardening.ts` | 125 | `projectConfigTrust` | delete | `const config = await loadRuntimeConfig({ workspaceRoot, projectConfigTrust: "trusted" });` |
| `src/channels/gateway-runner.ts` | 11 | `projectConfigTrust` | delete | `projectConfigTrust?: "trusted" \| "untrusted";` |
| `src/cli/cli-model.test.ts` | 1436 | `projectConfigTrust` | delete | `projectConfigTrust: "untrusted",` |
| `src/cli/cli-model.test.ts` | 1449 | `projectConfigTrust` | delete | `projectConfigTrust: "untrusted",` |
| `src/cli/cli.ts` | 178 | `projectConfigTrust` | delete | `projectConfigTrust?: "trusted" \| "untrusted";` |
| `src/cli/gateway-commands.ts` | 66 | `projectConfigTrust` | delete | `projectConfigTrust?: "trusted" \| "untrusted";` |
| `src/cli/interactive-launcher.ts` | 10 | `projectConfigTrust` | delete | `projectConfigTrust?: "trusted" \| "untrusted";` |
| `src/cli/interactive-launcher.ts` | 35 | `projectConfigTrust` | delete | `projectConfigTrust: options.projectConfigTrust` |
| `src/cli/interactive-launcher.ts` | 35 | `projectConfigTrust` | delete | `projectConfigTrust: options.projectConfigTrust` |
| `src/cli/interactive-launcher.ts` | 117 | `projectConfigTrust` | delete | `projectConfigTrust: options.projectConfigTrust` |
| `src/cli/interactive-launcher.ts` | 117 | `projectConfigTrust` | delete | `projectConfigTrust: options.projectConfigTrust` |
| `src/config/config-tools.ts` | 26 | `projectConfigTrust` | delete | `projectConfigTrust?: "trusted" \| "untrusted";` |
| `src/config/provider-config-mutations.test.ts` | 585 | `projectConfigTrust` | delete | `projectConfigTrust: "untrusted"` |
| `src/config/provider-config-mutations.test.ts` | 598 | `projectConfigTrust` | delete | `projectConfigTrust: "untrusted"` |
| `src/config/provider-config-mutations.test.ts` | 634 | `projectConfigTrust` | delete | `projectConfigTrust: "untrusted"` |
| `src/config/provider-config-mutations.test.ts` | 647 | `projectConfigTrust` | delete | `projectConfigTrust: "untrusted"` |
| `src/config/provider-config-mutations.test.ts` | 719 | `projectConfigTrust` | delete | `projectConfigTrust: "untrusted"` |
| `src/config/runtime-config.test.ts` | 78 | `projectConfigTrust` | delete | `projectConfigTrust: "trusted"` |
| `src/config/runtime-config.test.ts` | 98 | `projectConfigTrust` | delete | `projectConfigTrust: "trusted"` |
| `src/config/runtime-config.test.ts` | 122 | `projectConfigTrust` | delete | `const loaded = await loadRuntimeConfig({ workspaceRoot: workspace, userConfigPath: join(workspace, "nonexistent-user-config.json"), projectConfigTrust: "trusted" });` |
| `src/config/runtime-config.test.ts` | 137 | `projectConfigTrust` | delete | `const loaded = await loadRuntimeConfig({ workspaceRoot: workspace, userConfigPath: join(workspace, "nonexistent-user-config.json"), projectConfigTrust: "trusted" });` |
| `src/config/runtime-config.test.ts` | 161 | `projectConfigTrust` | delete | `const loaded = await loadRuntimeConfig({ workspaceRoot: workspace, userConfigPath: join(workspace, "nonexistent-user-config.json"), projectConfigTrust: "trusted" });` |
| `src/config/runtime-config.test.ts` | 176 | `projectConfigTrust` | delete | `const loaded = await loadRuntimeConfig({ workspaceRoot: workspace, userConfigPath: join(workspace, "nonexistent-user-config.json"), projectConfigTrust: "trusted" });` |
| `src/config/runtime-config.test.ts` | 191 | `projectConfigTrust` | delete | `const loaded = await loadRuntimeConfig({ workspaceRoot: workspace, userConfigPath: join(workspace, "nonexistent-user-config.json"), projectConfigTrust: "trusted" });` |
| `src/config/runtime-config.test.ts` | 206 | `projectConfigTrust` | delete | `const loaded = await loadRuntimeConfig({ workspaceRoot: workspace, userConfigPath: join(workspace, "nonexistent-user-config.json"), projectConfigTrust: "trusted" });` |
| `src/config/runtime-config.test.ts` | 242 | `projectConfigTrust` | delete | `projectConfigTrust: "trusted"` |
| `src/config/runtime-config.test.ts` | 282 | `projectConfigTrust` | delete | `projectConfigTrust: "trusted"` |
| `src/config/runtime-config.test.ts` | 309 | `projectConfigTrust` | delete | `projectConfigTrust: "trusted"` |
| `src/config/runtime-config.test.ts` | 328 | `projectConfigTrust` | delete | `projectConfigTrust: "trusted"` |
| `src/config/runtime-config.test.ts` | 352 | `projectConfigTrust` | delete | `projectConfigTrust: "trusted"` |
| `src/config/runtime-config.test.ts` | 377 | `projectConfigTrust` | delete | `projectConfigTrust: "trusted"` |
| `src/config/runtime-config.test.ts` | 430 | `projectConfigTrust` | delete | `projectConfigTrust: "trusted"` |
| `src/config/runtime-config.test.ts` | 469 | `projectConfigTrust` | delete | `projectConfigTrust: "trusted"` |
| `src/config/runtime-config.test.ts` | 589 | `projectConfigTrust` | delete | `it("does not load project config when projectConfigTrust is omitted", async () => {` |
| `src/config/runtime-config.test.ts` | 607 | `projectConfigTrust` | delete | `it("does not load project config when projectConfigTrust is 'untrusted'", async () => {` |
| `src/config/runtime-config.test.ts` | 618 | `projectConfigTrust` | delete | `projectConfigTrust: "untrusted"` |
| `src/config/runtime-config.test.ts` | 625 | `projectConfigTrust` | delete | `it("loads project config when projectConfigTrust is 'trusted'", async () => {` |
| `src/config/runtime-config.test.ts` | 636 | `projectConfigTrust` | delete | `projectConfigTrust: "trusted"` |
| `src/config/runtime-config.test.ts` | 646 | `projectConfigTrust` | delete | `it("has no production loadRuntimeConfig calls that omit projectConfigTrust and are not wrappers", async () => {` |
| `src/config/runtime-config.test.ts` | 655 | `projectConfigTrust` | delete | `// Allow calls that pass 'options' (types carry projectConfigTrust)` |
| `src/config/runtime-config.test.ts` | 657 | `projectConfigTrust` | delete | `// All other production callsites must explicitly pass projectConfigTrust.` |
| `src/config/runtime-config.test.ts` | 658 | `projectConfigTrust` | delete | `if (call.includes("projectConfigTrust")) continue;` |
| `src/config/runtime-config.test.ts` | 683 | `projectConfigTrust` | delete | `projectConfigTrust: "untrusted"` |
| `src/config/runtime-config.test.ts` | 707 | `projectConfigTrust` | delete | `projectConfigTrust: "untrusted"` |
| `src/config/runtime-config.test.ts` | 730 | `projectConfigTrust` | delete | `projectConfigTrust: "untrusted"` |
| `src/config/runtime-config.test.ts` | 754 | `projectConfigTrust` | delete | `projectConfigTrust: "untrusted"` |
| `src/config/runtime-config.test.ts` | 776 | `projectConfigTrust` | delete | `projectConfigTrust: "untrusted"` |
| `src/config/runtime-config.test.ts` | 799 | `projectConfigTrust` | delete | `projectConfigTrust: "untrusted"` |
| `src/config/runtime-config.test.ts` | 825 | `projectConfigTrust` | delete | `projectConfigTrust: "untrusted"` |
| `src/config/runtime-config.test.ts` | 883 | `projectConfigTrust` | delete | `projectConfigTrust: "untrusted"` |
| `src/config/runtime-config.ts` | 565 | `projectConfigTrust` | delete | `projectConfigTrust?: "trusted" \| "untrusted";` |
| `src/config/runtime-config.ts` | 574 | `projectConfigTrust` | delete | `if (options.projectConfigTrust === "trusted") {` |
| `src/config/runtime-config.ts` | 735 | `projectConfigTrust` | delete | `export async function loadUserRuntimeConfig(options: Omit<LoadRuntimeConfigOptions, "projectConfigTrust">): Promise<LoadedRuntimeConfig> {` |
| `src/config/runtime-config.ts` | 736 | `projectConfigTrust` | delete | `return loadRuntimeConfig({ ...options, projectConfigTrust: "untrusted" });` |
| `src/config/runtime-config.ts` | 739 | `projectConfigTrust` | delete | `export async function loadTrustedRuntimeConfig(options: Omit<LoadRuntimeConfigOptions, "projectConfigTrust">): Promise<LoadedRuntimeConfig> {` |
| `src/config/runtime-config.ts` | 740 | `projectConfigTrust` | delete | `return loadRuntimeConfig({ ...options, projectConfigTrust: "trusted" });` |
| `src/gateway/supervisor.ts` | 326 | `projectConfigTrust` | delete | `const projectConfigTrust = options.projectConfigTrust ?? await (async () => {` |
| `src/gateway/supervisor.ts` | 326 | `projectConfigTrust` | delete | `const projectConfigTrust = options.projectConfigTrust ?? await (async () => {` |
| `src/gateway/supervisor.ts` | 332 | `projectConfigTrust` | delete | `const loadConfig = () => projectConfigTrust === "trusted"` |
| `src/index.ts` | 49 | `projectConfigTrust` | delete | `projectConfigTrust: workspaceTrusted ? "trusted" : "untrusted"` |
| `src/index.ts` | 64 | `projectConfigTrust` | delete | `projectConfigTrust: workspaceTrusted ? "trusted" : "untrusted"` |
| `src/index.ts` | 77 | `projectConfigTrust` | delete | `const launchResult = await launchInteractiveSession({ workspaceRoot, projectConfigTrust: workspaceTrusted ? "trusted" : "untrusted" });` |
| `src/index.ts` | 106 | `projectConfigTrust` | delete | `projectConfigTrust: workspaceTrusted ? "trusted" : "untrusted"` |
| `src/index.ts` | 156 | `projectConfigTrust` | delete | `projectConfigTrust: nowTrusted ? "trusted" : "untrusted"` |
| `src/index.ts` | 168 | `projectConfigTrust` | delete | `projectConfigTrust: workspaceTrusted ? "trusted" : "untrusted"` |
| `src/index.ts` | 192 | `projectConfigTrust` | delete | `projectConfigTrust: workspaceTrusted ? "trusted" : "untrusted"` |
| `src/onboarding/review/apply-executor.test.ts` | 309 | `projectConfigTrust` | delete | `describe("verifyReviewedSetup projectConfigTrust threading", () => {` |
| `src/onboarding/review/apply-executor.test.ts` | 310 | `projectConfigTrust` | delete | `it("includes project config when projectConfigTrust is trusted", async () => {` |
| `src/onboarding/review/apply-executor.test.ts` | 319 | `projectConfigTrust` | delete | `projectConfigTrust: "trusted",` |
| `src/onboarding/review/apply-executor.test.ts` | 325 | `projectConfigTrust` | delete | `it("skips project config when projectConfigTrust is untrusted", async () => {` |
| `src/onboarding/review/apply-executor.test.ts` | 334 | `projectConfigTrust` | delete | `projectConfigTrust: "untrusted",` |
| `src/onboarding/review/apply-executor.test.ts` | 340 | `projectConfigTrust` | delete | `it("remains fail-closed when projectConfigTrust is omitted", async () => {` |
| `src/onboarding/review/apply-executor.ts` | 48 | `projectConfigTrust` | delete | `readonly projectConfigTrust?: "trusted" \| "untrusted";` |
| `src/onboarding/review/apply-executor.ts` | 156 | `projectConfigTrust` | delete | `projectConfigTrust: options.projectConfigTrust,` |
| `src/onboarding/review/apply-executor.ts` | 156 | `projectConfigTrust` | delete | `projectConfigTrust: options.projectConfigTrust,` |
| `src/onboarding/setup-entry-state.test.ts` | 212 | `projectConfigTrust` | delete | `it("includes project config in verification when projectConfigTrust is trusted", async () => {` |
| `src/onboarding/setup-entry-state.test.ts` | 219 | `projectConfigTrust` | delete | `const state = await collectSetupEntryState({ homeDir, workspaceRoot, projectConfigTrust: "trusted" });` |
| `src/onboarding/setup-entry-state.test.ts` | 223 | `projectConfigTrust` | delete | `it("excludes project config in verification when projectConfigTrust is untrusted", async () => {` |
| `src/onboarding/setup-entry-state.test.ts` | 230 | `projectConfigTrust` | delete | `const state = await collectSetupEntryState({ homeDir, workspaceRoot, projectConfigTrust: "untrusted" });` |
| `src/onboarding/setup-entry-state.ts` | 70 | `projectConfigTrust` | delete | `readonly projectConfigTrust?: "trusted" \| "untrusted";` |
| `src/onboarding/setup-entry-state.ts` | 107 | `projectConfigTrust` | delete | `projectConfigTrust: options.projectConfigTrust,` |
| `src/onboarding/setup-entry-state.ts` | 107 | `projectConfigTrust` | delete | `projectConfigTrust: options.projectConfigTrust,` |
| `src/onboarding/verification.test.ts` | 176 | `projectConfigTrust` | delete | `it("includes project config source when projectConfigTrust is trusted", async () => {` |
| `src/onboarding/verification.test.ts` | 185 | `projectConfigTrust` | delete | `projectConfigTrust: "trusted",` |
| `src/onboarding/verification.test.ts` | 190 | `projectConfigTrust` | delete | `it("excludes project config source when projectConfigTrust is untrusted", async () => {` |
| `src/onboarding/verification.test.ts` | 199 | `projectConfigTrust` | delete | `projectConfigTrust: "untrusted",` |
| `src/onboarding/verification.ts` | 21 | `projectConfigTrust` | delete | `projectConfigTrust?: "trusted" \| "untrusted";` |
| `src/runtime/create-runtime.test.ts` | 79 | `projectConfigTrust` | delete | `projectConfigTrust?: "trusted" \| "untrusted";` |
| `src/runtime/create-runtime.test.ts` | 107 | `projectConfigTrust` | delete | `it("does not start/register MCP when projectConfigTrust is omitted", async () => {` |
| `src/runtime/create-runtime.test.ts` | 116 | `projectConfigTrust` | delete | `it("does not start/register MCP when projectConfigTrust is 'untrusted'", async () => {` |
| `src/runtime/create-runtime.test.ts` | 119 | `projectConfigTrust` | delete | `projectConfigTrust: "untrusted"` |
| `src/runtime/create-runtime.test.ts` | 126 | `projectConfigTrust` | delete | `it("attempts to start/register MCP when projectConfigTrust is 'trusted'", async () => {` |
| `src/runtime/create-runtime.test.ts` | 129 | `projectConfigTrust` | delete | `projectConfigTrust: "trusted"` |
| `src/runtime/create-runtime.test.ts` | 213 | `projectConfigTrust` | delete | `it("loads project config in verification when projectConfigTrust is trusted", async () => {` |
| `src/runtime/create-runtime.test.ts` | 214 | `projectConfigTrust` | delete | `const options = await minimalRuntimeOptions({ projectConfigTrust: "trusted" });` |
| `src/runtime/create-runtime.test.ts` | 244 | `projectConfigTrust` | delete | `it("skips project config in verification when projectConfigTrust is untrusted", async () => {` |
| `src/runtime/create-runtime.test.ts` | 245 | `projectConfigTrust` | delete | `const options = await minimalRuntimeOptions({ projectConfigTrust: "untrusted" });` |
| `src/runtime/create-runtime.ts` | 117 | `projectConfigTrust` | delete | `projectConfigTrust?: "trusted" \| "untrusted";` |
| `src/runtime/create-runtime.ts` | 285 | `projectConfigTrust` | delete | `const effectiveMcpServers = options.projectConfigTrust === "trusted" ? (options.mcpServers ?? {}) : {};` |
| `src/runtime/create-runtime.ts` | 436 | `projectConfigTrust` | delete | `projectConfigTrust: options.projectConfigTrust` |
| `src/runtime/create-runtime.ts` | 436 | `projectConfigTrust` | delete | `projectConfigTrust: options.projectConfigTrust` |
| `src/runtime/create-runtime.ts` | 997 | `projectConfigTrust` | delete | `projectConfigTrust: options.projectConfigTrust,` |
| `src/runtime/create-runtime.ts` | 997 | `projectConfigTrust` | delete | `projectConfigTrust: options.projectConfigTrust,` |

## credentialPools

| File | Line | Symbol | Proposed action | Occurrence |
|---|---:|---|---|---|
| `scripts/provider-hardening.ts` | 194 | `credentialPools` | delete | `credentialPools: config.credentialPools,` |
| `scripts/provider-hardening.ts` | 194 | `credentialPools` | delete | `credentialPools: config.credentialPools,` |
| `src/acp/server.ts` | 789 | `credentialPools` | delete | `credentialPools: config.credentialPools,` |
| `src/acp/server.ts` | 789 | `credentialPools` | delete | `credentialPools: config.credentialPools,` |
| `src/acp/server.ts` | 806 | `credentialPools` | delete | `credentialPools: config.credentialPools` |
| `src/acp/server.ts` | 806 | `credentialPools` | delete | `credentialPools: config.credentialPools` |
| `src/cli/cli-model.test.ts` | 423 | `credentialPools` | delete | `credentialPools: {` |
| `src/cli/cli.ts` | 1710 | `credentialPools` | delete | `\`Credential pools: ${config?.credentialPools.snapshots().map((snapshot) => \`${snapshot.provider}:${snapshot.entries.length}\`).join(", ") \|\| "none"}\`,` |
| `src/config/config-tools.ts` | 54 | `credentialPools` | delete | `\`Credential pools: ${loaded.credentialPools.snapshots().map((snapshot) => \`${snapshot.provider}:${snapshot.entries.length}\`).join(", ") \|\| "none"}\`,` |
| `src/config/config-tools.ts` | 63 | `credentialPools` | delete | `credentialPools: loaded.credentialPools.snapshots(),` |
| `src/config/config-tools.ts` | 63 | `credentialPools` | delete | `credentialPools: loaded.credentialPools.snapshots(),` |
| `src/config/provider-config-mutations.test.ts` | 142 | `credentialPools` | delete | `expect(config.credentialPools).toBeUndefined();` |
| `src/config/provider-config-mutations.test.ts` | 155 | `credentialPools` | delete | `expect(config.credentialPools).toBeDefined();` |
| `src/config/provider-config-mutations.test.ts` | 156 | `credentialPools` | delete | `expect(config.credentialPools!.openai!.strategy).toBe("round_robin");` |
| `src/config/provider-config-mutations.test.ts` | 436 | `credentialPools` | delete | `expect(result.config.credentialPools).toBeUndefined();` |
| `src/config/provider-config-mutations.test.ts` | 451 | `credentialPools` | delete | `expect(result.config.credentialPools).toBeDefined();` |
| `src/config/provider-config-mutations.test.ts` | 452 | `credentialPools` | delete | `expect(result.config.credentialPools!.deepseek!.strategy).toBe("round_robin");` |
| `src/config/provider-config-mutations.ts` | 137 | `credentialPools` | delete | `? { credentialPools: credentialPoolsPatch as EstaCodaConfig["credentialPools"] }` |
| `src/config/provider-config-mutations.ts` | 137 | `credentialPools` | delete | `? { credentialPools: credentialPoolsPatch as EstaCodaConfig["credentialPools"] }` |
| `src/config/provider-diagnostics.ts` | 23 | `credentialPools` | delete | `const pools = config.credentialPools.snapshots();` |
| `src/config/provider-diagnostics.ts` | 136 | `credentialPools` | delete | `credentialPools: config.credentialPools` |
| `src/config/provider-diagnostics.ts` | 136 | `credentialPools` | delete | `credentialPools: config.credentialPools` |
| `src/config/runtime-config.ts` | 250 | `credentialPools` | delete | `credentialPools?: Record<string, {` |
| `src/config/runtime-config.ts` | 368 | `credentialPools` | delete | `credentialPools: CredentialPoolRegistry;` |
| `src/config/runtime-config.ts` | 596 | `credentialPools` | delete | `const credentialPools = buildCredentialPools(config);` |
| `src/config/runtime-config.ts` | 668 | `credentialPools` | delete | `credentialPools,` |
| `src/config/runtime-config.ts` | 750 | `credentialPools` | delete | `credentialPools: mergeRecordEntries(merged.credentialPools, config.credentialPools),` |
| `src/config/runtime-config.ts` | 750 | `credentialPools` | delete | `credentialPools: mergeRecordEntries(merged.credentialPools, config.credentialPools),` |
| `src/config/runtime-config.ts` | 750 | `credentialPools` | delete | `credentialPools: mergeRecordEntries(merged.credentialPools, config.credentialPools),` |
| `src/config/runtime-config.ts` | 1360 | `credentialPools` | delete | `for (const [provider, poolConfig] of Object.entries(config.credentialPools ?? {})) {` |
| `src/config/runtime-config.ts` | 1466 | `credentialPools` | delete | `credentialPools: {` |
| `src/diagnostics/model-diagnostics.test.ts` | 11 | `credentialPools` | delete | `const credentialPools = new CredentialPoolRegistry();` |
| `src/diagnostics/model-diagnostics.test.ts` | 37 | `credentialPools` | delete | `credentialPools,` |
| `src/diagnostics/model-diagnostics.ts` | 95 | `credentialPools` | delete | `const pools = config.credentialPools.snapshots();` |
| `src/gateway/supervisor.test.ts` | 116 | `credentialPools` | delete | `credentialPools: {},` |
| `src/gateway/supervisor.test.ts` | 216 | `credentialPools` | delete | `expect(options.credentialPools).toBe(latestConfig.credentialPools);` |
| `src/gateway/supervisor.test.ts` | 216 | `credentialPools` | delete | `expect(options.credentialPools).toBe(latestConfig.credentialPools);` |
| `src/gateway/supervisor.ts` | 118 | `credentialPools` | delete | `credentialPools: latestConfig.credentialPools,` |
| `src/gateway/supervisor.ts` | 118 | `credentialPools` | delete | `credentialPools: latestConfig.credentialPools,` |
| `src/gateway/supervisor.ts` | 129 | `credentialPools` | delete | `credentialPools: latestConfig.credentialPools,` |
| `src/gateway/supervisor.ts` | 129 | `credentialPools` | delete | `credentialPools: latestConfig.credentialPools,` |
| `src/gateway/supervisor.ts` | 513 | `credentialPools` | delete | `credentialPools: latestConfig.credentialPools,` |
| `src/gateway/supervisor.ts` | 513 | `credentialPools` | delete | `credentialPools: latestConfig.credentialPools,` |
| `src/gateway/supervisor.ts` | 870 | `credentialPools` | delete | `credentialPools: config.credentialPools,` |
| `src/gateway/supervisor.ts` | 870 | `credentialPools` | delete | `credentialPools: config.credentialPools,` |
| `src/gateway/supervisor.ts` | 927 | `credentialPools` | delete | `credentialPools: config.credentialPools,` |
| `src/gateway/supervisor.ts` | 927 | `credentialPools` | delete | `credentialPools: config.credentialPools,` |
| `src/index.ts` | 143 | `credentialPools` | delete | `credentialPools: latestConfig.credentialPools,` |
| `src/index.ts` | 143 | `credentialPools` | delete | `credentialPools: latestConfig.credentialPools,` |
| `src/onboarding/review/apply-executor.test.ts` | 144 | `credentialPools` | delete | `credentialPools?: Record<string, { entries?: Array<{ source?: { kind?: string; name?: string } }> }>;` |
| `src/providers/provider-executor-route.test.ts` | 363 | `credentialPools` | delete | `const exec = new ProviderExecutor({ registry, credentialPools: poolRegistry });` |
| `src/providers/provider-executor.ts` | 88 | `credentialPools` | delete | `credentialPools?: CredentialPoolRegistry;` |
| `src/providers/provider-executor.ts` | 94 | `credentialPools` | delete | `readonly #credentialPools: CredentialPoolRegistry \| undefined;` |
| `src/providers/provider-executor.ts` | 99 | `credentialPools` | delete | `this.#credentialPools = options.credentialPools;` |
| `src/providers/provider-executor.ts` | 99 | `credentialPools` | delete | `this.#credentialPools = options.credentialPools;` |
| `src/providers/provider-executor.ts` | 232 | `credentialPools` | delete | `credentialPools: this.#credentialPools,` |
| `src/providers/provider-executor.ts` | 232 | `credentialPools` | delete | `credentialPools: this.#credentialPools,` |
| `src/providers/provider-executor.ts` | 399 | `credentialPools` | delete | `if (credential !== undefined && this.#credentialPools !== undefined && route.apiKeyEnv === undefined) {` |
| `src/providers/provider-executor.ts` | 400 | `credentialPools` | delete | `this.#credentialPools.reportSuccess(route.provider, credential.id);` |
| `src/providers/provider-executor.ts` | 426 | `credentialPools` | delete | `if (credential !== undefined && this.#credentialPools !== undefined && route.apiKeyEnv === undefined) {` |
| `src/providers/provider-executor.ts` | 427 | `credentialPools` | delete | `this.#credentialPools.reportFailure(route.provider, credential.id, response.errorClass ?? "unknown");` |
| `src/providers/runtime-credential-resolver.test.ts` | 154 | `credentialPools` | delete | `credentialPools: poolRegistry,` |
| `src/providers/runtime-credential-resolver.test.ts` | 183 | `credentialPools` | delete | `credentialPools: poolRegistry,` |
| `src/providers/runtime-credential-resolver.test.ts` | 264 | `credentialPools` | delete | `credentialPools: poolRegistry,` |
| `src/providers/runtime-credential-resolver.test.ts` | 286 | `credentialPools` | delete | `credentialPools: poolRegistry,` |
| `src/providers/runtime-credential-resolver.ts` | 22 | `credentialPools` | delete | `credentialPools?: CredentialPoolRegistry;` |
| `src/providers/runtime-credential-resolver.ts` | 91 | `credentialPools` | delete | `if (options.credentialPools !== undefined) {` |
| `src/providers/runtime-credential-resolver.ts` | 92 | `credentialPools` | delete | `const poolCredential = options.credentialPools.resolve(options.providerId);` |
| `src/runtime/create-runtime.ts` | 109 | `credentialPools` | delete | `credentialPools?: CredentialPoolRegistry;` |
| `src/runtime/create-runtime.ts` | 374 | `credentialPools` | delete | `credentialPools: options.credentialPools` |
| `src/runtime/create-runtime.ts` | 374 | `credentialPools` | delete | `credentialPools: options.credentialPools` |
| `src/runtime/create-runtime.ts` | 420 | `credentialPools` | delete | `credentialPools: options.credentialPools` |
| `src/runtime/create-runtime.ts` | 420 | `credentialPools` | delete | `credentialPools: options.credentialPools` |
| `src/runtime/create-runtime.ts` | 536 | `credentialPools` | delete | `credentialPools: options.credentialPools` |
| `src/runtime/create-runtime.ts` | 536 | `credentialPools` | delete | `credentialPools: options.credentialPools` |
| `src/runtime/runtime-fingerprint.test.ts` | 19 | `credentialPools` | delete | `credentialPools: {} as unknown as LoadedRuntimeConfig["credentialPools"],` |
| `src/runtime/runtime-fingerprint.test.ts` | 19 | `credentialPools` | delete | `credentialPools: {} as unknown as LoadedRuntimeConfig["credentialPools"],` |

## scope

| File | Line | Symbol | Proposed action | Occurrence |
|---|---:|---|---|---|
| `.github/PULL_REQUEST_TEMPLATE.md` | 59 | `scope` | keep temporarily | `- [ ] I verified the implementation matches the requested scope` |
| `AGENTS.md` | 325 | `scope` | keep temporarily | `8. Keep Arabic and mixed-language routing in scope if the change touches language detection.` |
| `CONTRIBUTING.md` | 450 | `scope` | keep temporarily | `<type>(<scope>): <description>` |
| `CONTRIBUTING.md` | 523 | `scope` | keep temporarily | `git commit -m "fix(scope): short description"` |
| `docs/architecture/overview.md` | 313 | `scope` | keep temporarily | `- CLI approvals: same scope model through runtime-backed grants` |
| `docs/architecture/taskflow.md` | 112 | `scope` | keep temporarily | `- \`toolName\`, \`targetKey\`, \`targetSummary\`, \`scope\`` |
| `docs/operations/onboarding-baseline-audit.md` | 177 | `scope` | keep temporarily | `Each draft has a stable id, kind, source step or section/action id, risk surface, target path or config scope where applicable, redacted review metadata, dry-run apply intent me...` |
| `docs/operations/onboarding-baseline-audit.md` | 224 | `scope` | keep temporarily | `Each manifest line has a stable id, section, source draft ids, copy and summary keys, risk surface, target path or config scope where applicable, redacted review metadata, sever...` |
| `docs/operations/onboarding-legacy-cutover-plan.md` | 698 | `scope` | keep temporarily | `- Arabic onboarding scope and token-isolation behavior.` |
| `docs/operations/prelaunch-milestones.md` | 93 | `scope` | keep temporarily | `6. **Runtime code evolution** — Explicitly out of scope until post-MVP.` |
| `docs/rendering-guide.md` | 203 | `scope` | keep temporarily | `scope: "both",` |
| `docs/subsystems/traces.md` | 20 | `scope` | keep temporarily | `\| \`src/trajectory/trajectory-recorder.ts\` \| ~120 \| In-memory event recorder (session scope) \|` |
| `docs/ui-architecture.md` | 203 | `scope` | keep temporarily | `- The registry supports filtering by scope, visibility, and parent.` |
| `Release_Notes_v0.0.3.md` | 66 | `scope` | keep temporarily | `- Telegram/channel integrations are out of scope for v0.0.3.` |
| `Release_Notes_v0.0.5.md` | 39 | `scope` | keep temporarily | `- Commands carry metadata: scope (CLI/slash/both), visibility, category, description, and arguments.` |
| `ROADMAP.md` | 131 | `scope` | keep temporarily | `The following are out of scope for the v0.4–v0.10 phase:` |
| `scripts/provider-hardening.ts` | 120 | `scope` | delete | `scope: "project"` |
| `SECURITY.md` | 5 | `scope` | keep temporarily | `This document defines how to report vulnerabilities, what security boundaries EstaCoda intends to enforce, and what is considered in scope for security review.` |
| `SECURITY.md` | 131 | `scope` | keep temporarily | `- Silent mutation of generated docs, config files, lockfiles, or source files outside the requested scope.` |
| `SECURITY.md` | 220 | `scope` | keep temporarily | `The dependency and skill supply chain is in scope.` |
| `SECURITY.md` | 232 | `scope` | keep temporarily | `## In-scope vulnerability examples` |
| `SECURITY.md` | 234 | `scope` | keep temporarily | `The following are in scope:` |
| `SECURITY.md` | 249 | `scope` | keep temporarily | `## Out-of-scope or lower-priority reports` |
| `skills/official/youtube-knowledge-base/SKILL.md` | 46 | `scope` | keep temporarily | `"description": "Check that the resulting knowledge base answers the user's requested scope.",` |
| `src/channels/channel-gateway.ts` | 105 | `scope` | keep temporarily | `scope: ApprovalScope;` |
| `src/channels/channel-gateway.ts` | 1534 | `scope` | keep temporarily | `const scope = parseApprovalScope(message.text);` |
| `src/channels/channel-gateway.ts` | 1535 | `scope` | keep temporarily | `if (scope !== "always") {` |
| `src/channels/channel-gateway.ts` | 1542 | `scope` | keep temporarily | `scope,` |
| `src/channels/channel-gateway.ts` | 1543 | `scope` | keep temporarily | `sessionId: scope === "session" ? pending.sessionId : undefined` |
| `src/channels/channel-gateway.ts` | 1549 | `scope` | keep temporarily | `if (scope === "always") {` |
| `src/channels/channel-gateway.ts` | 1559 | `scope` | keep temporarily | `const approvalText = scope === "always"` |
| `src/channels/channel-gateway.ts` | 1569 | `scope` | keep temporarily | `\`Scope: ${scope}\`,` |
| `src/channels/channel-gateway.ts` | 1579 | `scope` | keep temporarily | `approvalScope: scope` |
| `src/channels/channel-gateway.ts` | 1686 | `scope` | keep temporarily | `(grant.scope !== "session" \|\| grant.sessionId === sessionId)` |
| `src/channels/channel-gateway.ts` | 1692 | `scope` | keep temporarily | `if (grant?.scope === "once") {` |
| `src/channels/channel-gateway.ts` | 1742 | `scope` | keep temporarily | `(grant.scope !== "session" \|\| grant.sessionId === sessionId)` |
| `src/channels/channel-gateway.ts` | 2015 | `scope` | keep temporarily | `\`scope=${grant.scope}\`` |
| `src/channels/channel-gateway.ts` | 2015 | `scope` | keep temporarily | `\`scope=${grant.scope}\`` |
| `src/cli/cli.ts` | 1405 | `scope` | delete | `const scope = hasFlag(args, "--project") ? "project" : hasFlag(args, "--user") ? "user" : undefined;` |
| `src/cli/cli.ts` | 1419 | `scope` | keep temporarily | `scope` |
| `src/cli/cli.ts` | 1449 | `scope` | delete | `const scope = hasFlag(args, "--project") ? "project" : hasFlag(args, "--user") ? "user" : undefined;` |
| `src/cli/cli.ts` | 1457 | `scope` | keep temporarily | `scope` |
| `src/cli/cli.ts` | 1486 | `scope` | delete | `const scope = hasFlag(args, "--project") ? "project" : hasFlag(args, "--user") ? "user" : undefined;` |
| `src/cli/cli.ts` | 1492 | `scope` | keep temporarily | `scope` |
| `src/cli/cli.ts` | 1521 | `scope` | delete | `const scope = hasFlag(args, "--project") ? "project" : hasFlag(args, "--user") ? "user" : undefined;` |
| `src/cli/cli.ts` | 1525 | `scope` | keep temporarily | `scope` |
| `src/cli/cli.ts` | 3073 | `scope` | delete | `parsed.scope = "project";` |
| `src/cli/cli.ts` | 3075 | `scope` | delete | `parsed.scope = "user";` |
| `src/cli/cli.ts` | 3119 | `scope` | delete | `parsed.scope = "project";` |
| `src/cli/cli.ts` | 3121 | `scope` | delete | `parsed.scope = "user";` |
| `src/cli/cli.ts` | 3199 | `scope` | delete | `parsed.scope = "project";` |
| `src/cli/cli.ts` | 3201 | `scope` | delete | `parsed.scope = "user";` |
| `src/cli/cli.ts` | 3224 | `scope` | delete | `parsed.scope = "project";` |
| `src/cli/cli.ts` | 3226 | `scope` | delete | `parsed.scope = "user";` |
| `src/cli/cli.ts` | 3258 | `scope` | delete | `parsed.scope = "project";` |
| `src/cli/cli.ts` | 3260 | `scope` | delete | `parsed.scope = "user";` |
| `src/cli/cli.ts` | 3295 | `scope` | delete | `parsed.scope = "project";` |
| `src/cli/cli.ts` | 3297 | `scope` | delete | `parsed.scope = "user";` |
| `src/cli/cli.ts` | 3311 | `scope` | delete | `scope?: "user" \| "project";` |
| `src/cli/cli.ts` | 3316 | `scope` | delete | `scope?: "user" \| "project";` |
| `src/cli/cli.ts` | 3330 | `scope` | delete | `parsed.scope = "project";` |
| `src/cli/cli.ts` | 3332 | `scope` | delete | `parsed.scope = "user";` |
| `src/cli/cli.ts` | 3413 | `scope` | delete | `parsed.scope = "project";` |
| `src/cli/cli.ts` | 3415 | `scope` | delete | `parsed.scope = "user";` |
| `src/cli/cli.ts` | 3573 | `scope` | delete | `parsed.scope = "project";` |
| `src/cli/cli.ts` | 3575 | `scope` | delete | `parsed.scope = "user";` |
| `src/cli/cli.ts` | 3666 | `scope` | keep temporarily | `const commands = commandRegistry.list({ scope: "cli" });` |
| `src/cli/command-registry.test.ts` | 22 | `scope` | keep temporarily | `scope: "slash",` |
| `src/cli/command-registry.test.ts` | 34 | `scope` | keep temporarily | `scope: "slash",` |
| `src/cli/command-registry.test.ts` | 51 | `scope` | keep temporarily | `scope: "slash",` |
| `src/cli/command-registry.test.ts` | 65 | `scope` | keep temporarily | `scope: "both",` |
| `src/cli/command-registry.test.ts` | 79 | `scope` | keep temporarily | `scope: "both",` |
| `src/cli/command-registry.test.ts` | 94 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.test.ts` | 102 | `scope` | keep temporarily | `scope: "slash",` |
| `src/cli/command-registry.test.ts` | 111 | `scope` | keep temporarily | `scope: "both",` |
| `src/cli/command-registry.test.ts` | 128 | `scope` | keep temporarily | `scope: "both",` |
| `src/cli/command-registry.test.ts` | 135 | `scope` | keep temporarily | `it("filters by scope", () => {` |
| `src/cli/command-registry.test.ts` | 142 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.test.ts` | 150 | `scope` | keep temporarily | `scope: "slash",` |
| `src/cli/command-registry.test.ts` | 158 | `scope` | keep temporarily | `scope: "both",` |
| `src/cli/command-registry.test.ts` | 161 | `scope` | keep temporarily | `const cli = registry.list({ scope: "cli" });` |
| `src/cli/command-registry.test.ts` | 166 | `scope` | keep temporarily | `const slash = registry.list({ scope: "slash" });` |
| `src/cli/command-registry.test.ts` | 179 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.test.ts` | 187 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.test.ts` | 195 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.test.ts` | 210 | `scope` | keep temporarily | `scope: "slash",` |
| `src/cli/command-registry.test.ts` | 218 | `scope` | keep temporarily | `scope: "slash",` |
| `src/cli/command-registry.test.ts` | 233 | `scope` | keep temporarily | `scope: "slash",` |
| `src/cli/command-registry.test.ts` | 241 | `scope` | keep temporarily | `scope: "slash",` |
| `src/cli/command-registry.test.ts` | 256 | `scope` | keep temporarily | `scope: "slash",` |
| `src/cli/command-registry.test.ts` | 271 | `scope` | keep temporarily | `scope: "slash",` |
| `src/cli/command-registry.test.ts` | 279 | `scope` | keep temporarily | `scope: "slash",` |
| `src/cli/command-registry.test.ts` | 287 | `scope` | keep temporarily | `it("combines scope and filter", () => {` |
| `src/cli/command-registry.test.ts` | 294 | `scope` | keep temporarily | `scope: "slash",` |
| `src/cli/command-registry.test.ts` | 302 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.test.ts` | 305 | `scope` | keep temporarily | `const filtered = registry.list({ scope: "slash", filter: "stat" });` |
| `src/cli/command-registry.test.ts` | 317 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.test.ts` | 325 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.test.ts` | 334 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.test.ts` | 340 | `scope` | keep temporarily | `it("returns categories scoped to a scope", () => {` |
| `src/cli/command-registry.test.ts` | 347 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.test.ts` | 355 | `scope` | keep temporarily | `scope: "slash",` |
| `src/cli/command-registry.test.ts` | 363 | `scope` | keep temporarily | `scope: "both",` |
| `src/cli/command-registry.test.ts` | 377 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.test.ts` | 385 | `scope` | keep temporarily | `expect(commandRegistry.resolve("help")?.scope).toBe("both");` |
| `src/cli/command-registry.test.ts` | 386 | `scope` | keep temporarily | `expect(commandRegistry.resolve("status")?.scope).toBe("slash");` |
| `src/cli/command-registry.test.ts` | 387 | `scope` | keep temporarily | `expect(commandRegistry.resolve("model")?.scope).toBe("both");` |
| `src/cli/command-registry.test.ts` | 388 | `scope` | keep temporarily | `expect(commandRegistry.resolve("exit")?.scope).toBe("slash");` |
| `src/cli/command-registry.test.ts` | 392 | `scope` | keep temporarily | `expect(commandRegistry.resolve("setup")?.scope).toBe("cli");` |
| `src/cli/command-registry.test.ts` | 393 | `scope` | keep temporarily | `expect(commandRegistry.resolve("verify")?.scope).toBe("cli");` |
| `src/cli/command-registry.test.ts` | 394 | `scope` | keep temporarily | `expect(commandRegistry.resolve("tools")?.scope).toBe("both");` |
| `src/cli/command-registry.test.ts` | 456 | `scope` | keep temporarily | `const slash = commandRegistry.list({ scope: "slash" });` |
| `src/cli/command-registry.test.ts` | 469 | `scope` | keep temporarily | `const cli = commandRegistry.list({ scope: "cli" });` |
| `src/cli/command-registry.test.ts` | 477 | `scope` | keep temporarily | `it("does not include duplicate entries for both-scope commands", () => {` |
| `src/cli/command-registry.ts` | 44 | `scope` | keep temporarily | `scope?: CommandScope;` |
| `src/cli/command-registry.ts` | 62 | `scope` | keep temporarily | `if (options?.scope) {` |
| `src/cli/command-registry.ts` | 64 | `scope` | keep temporarily | `(cmd) => cmd.scope === options.scope \|\| cmd.scope === "both"` |
| `src/cli/command-registry.ts` | 64 | `scope` | keep temporarily | `(cmd) => cmd.scope === options.scope \|\| cmd.scope === "both"` |
| `src/cli/command-registry.ts` | 64 | `scope` | keep temporarily | `(cmd) => cmd.scope === options.scope \|\| cmd.scope === "both"` |
| `src/cli/command-registry.ts` | 86 | `scope` | keep temporarily | `getCategories(scope?: CommandScope): readonly string[] {` |
| `src/cli/command-registry.ts` | 87 | `scope` | keep temporarily | `const cmds = scope` |
| `src/cli/command-registry.ts` | 90 | `scope` | keep temporarily | `(cmd.scope === scope \|\| cmd.scope === "both") &&` |
| `src/cli/command-registry.ts` | 90 | `scope` | keep temporarily | `(cmd.scope === scope \|\| cmd.scope === "both") &&` |
| `src/cli/command-registry.ts` | 90 | `scope` | keep temporarily | `(cmd.scope === scope \|\| cmd.scope === "both") &&` |
| `src/cli/command-registry.ts` | 116 | `scope` | keep temporarily | `scope: "both",` |
| `src/cli/command-registry.ts` | 124 | `scope` | keep temporarily | `scope: "slash",` |
| `src/cli/command-registry.ts` | 132 | `scope` | keep temporarily | `scope: "both",` |
| `src/cli/command-registry.ts` | 140 | `scope` | keep temporarily | `scope: "slash",` |
| `src/cli/command-registry.ts` | 148 | `scope` | keep temporarily | `scope: "slash",` |
| `src/cli/command-registry.ts` | 156 | `scope` | keep temporarily | `scope: "slash",` |
| `src/cli/command-registry.ts` | 164 | `scope` | keep temporarily | `scope: "slash",` |
| `src/cli/command-registry.ts` | 172 | `scope` | keep temporarily | `scope: "slash",` |
| `src/cli/command-registry.ts` | 180 | `scope` | keep temporarily | `scope: "both",` |
| `src/cli/command-registry.ts` | 188 | `scope` | keep temporarily | `scope: "slash",` |
| `src/cli/command-registry.ts` | 196 | `scope` | keep temporarily | `scope: "both",` |
| `src/cli/command-registry.ts` | 204 | `scope` | keep temporarily | `scope: "both",` |
| `src/cli/command-registry.ts` | 212 | `scope` | keep temporarily | `scope: "slash",` |
| `src/cli/command-registry.ts` | 220 | `scope` | keep temporarily | `scope: "slash",` |
| `src/cli/command-registry.ts` | 228 | `scope` | keep temporarily | `scope: "slash",` |
| `src/cli/command-registry.ts` | 236 | `scope` | keep temporarily | `scope: "slash",` |
| `src/cli/command-registry.ts` | 244 | `scope` | keep temporarily | `scope: "slash",` |
| `src/cli/command-registry.ts` | 252 | `scope` | keep temporarily | `scope: "slash",` |
| `src/cli/command-registry.ts` | 260 | `scope` | keep temporarily | `scope: "both",` |
| `src/cli/command-registry.ts` | 268 | `scope` | keep temporarily | `scope: "slash",` |
| `src/cli/command-registry.ts` | 276 | `scope` | keep temporarily | `scope: "slash",` |
| `src/cli/command-registry.ts` | 284 | `scope` | keep temporarily | `scope: "slash",` |
| `src/cli/command-registry.ts` | 292 | `scope` | keep temporarily | `scope: "both",` |
| `src/cli/command-registry.ts` | 300 | `scope` | keep temporarily | `scope: "both",` |
| `src/cli/command-registry.ts` | 308 | `scope` | keep temporarily | `scope: "both",` |
| `src/cli/command-registry.ts` | 316 | `scope` | keep temporarily | `scope: "slash",` |
| `src/cli/command-registry.ts` | 324 | `scope` | keep temporarily | `scope: "slash",` |
| `src/cli/command-registry.ts` | 334 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 342 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 350 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 358 | `scope` | keep temporarily | `scope: "both",` |
| `src/cli/command-registry.ts` | 366 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 374 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 382 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 390 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 398 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 406 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 414 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 422 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 430 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 438 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 446 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 454 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 462 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 470 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 478 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 486 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 494 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 502 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 510 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 518 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 526 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 537 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 546 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 555 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 564 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 573 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 582 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 593 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 602 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 611 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 622 | `scope` | keep temporarily | `scope: "both",` |
| `src/cli/command-registry.ts` | 631 | `scope` | keep temporarily | `scope: "both",` |
| `src/cli/command-registry.ts` | 640 | `scope` | keep temporarily | `scope: "both",` |
| `src/cli/command-registry.ts` | 649 | `scope` | keep temporarily | `scope: "both",` |
| `src/cli/command-registry.ts` | 658 | `scope` | keep temporarily | `scope: "both",` |
| `src/cli/command-registry.ts` | 667 | `scope` | keep temporarily | `scope: "both",` |
| `src/cli/command-registry.ts` | 676 | `scope` | keep temporarily | `scope: "both",` |
| `src/cli/command-registry.ts` | 685 | `scope` | keep temporarily | `scope: "both",` |
| `src/cli/command-registry.ts` | 694 | `scope` | keep temporarily | `scope: "both",` |
| `src/cli/command-registry.ts` | 703 | `scope` | keep temporarily | `scope: "both",` |
| `src/cli/command-registry.ts` | 714 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 723 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 732 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 741 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 750 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/command-registry.ts` | 761 | `scope` | keep temporarily | `scope: "cli",` |
| `src/cli/interactive-launcher.test.ts` | 115 | `scope` | delete | `scope: "user",` |
| `src/cli/interactive-launcher.test.ts` | 125 | `scope` | delete | `scope: "user",` |
| `src/cli/interactive-launcher.test.ts` | 149 | `scope` | delete | `scope: "user",` |
| `src/cli/interactive-launcher.test.ts` | 159 | `scope` | delete | `scope: "user",` |
| `src/cli/interactive-launcher.test.ts` | 189 | `scope` | delete | `scope: "user",` |
| `src/cli/model-setup.ts` | 135 | `scope` | delete | `scope?: "user" \| "project";` |
| `src/cli/model-setup.ts` | 144 | `scope` | delete | `scope?: "user" \| "project";` |
| `src/cli/model-setup.ts` | 162 | `scope` | delete | `parsed.scope = "project";` |
| `src/cli/model-setup.ts` | 164 | `scope` | delete | `parsed.scope = "user";` |
| `src/cli/model-setup.ts` | 191 | `scope` | delete | `parsed.scope = "project";` |
| `src/cli/model-setup.ts` | 193 | `scope` | delete | `parsed.scope = "user";` |
| `src/cli/model-setup.ts` | 253 | `scope` | keep temporarily | `scope: parsed.scope,` |
| `src/cli/model-setup.ts` | 253 | `scope` | keep temporarily | `scope: parsed.scope,` |
| `src/cli/model-setup.ts` | 336 | `scope` | delete | `const targetPath = parsed.scope === "project"` |
| `src/cli/model-setup.ts` | 413 | `scope` | keep temporarily | `scope: parsed.scope,` |
| `src/cli/model-setup.ts` | 413 | `scope` | keep temporarily | `scope: parsed.scope,` |
| `src/cli/session-help.ts` | 11 | `scope` | keep temporarily | `const commands = commandRegistry.list({ scope: "slash" });` |
| `src/cli/session-loop.ts` | 874 | `scope` | keep temporarily | `const scope = normalizeApprovalScope(answer);` |
| `src/cli/session-loop.ts` | 875 | `scope` | keep temporarily | `if (scope === undefined) {` |
| `src/cli/session-loop.ts` | 885 | `scope` | keep temporarily | `scope` |
| `src/cli/session-loop.ts` | 890 | `scope` | keep temporarily | `message: scope === "always"` |
| `src/cli/session-loop.ts` | 892 | `scope` | keep temporarily | `: \`Approval granted (${scope}). Retrying now.\`` |
| `src/cli/session-loop.ts` | 1077 | `scope` | keep temporarily | `\`${index + 1}. scope=${grant.scope} tool=${grant.toolName} risk=${grant.riskClass}${grant.targetSummary === undefined ? "" : \` target=${grant.targetSummary}\`}\`` |
| `src/cli/session-loop.ts` | 1077 | `scope` | keep temporarily | `\`${index + 1}. scope=${grant.scope} tool=${grant.toolName} risk=${grant.riskClass}${grant.targetSummary === undefined ? "" : \` target=${grant.targetSummary}\`}\`` |
| `src/cli/slash-menu.ts` | 73 | `scope` | keep temporarily | `scope: "slash",` |
| `src/cli/slash-menu.ts` | 102 | `scope` | keep temporarily | `scope: "slash",` |
| `src/config/config-tools.ts` | 112 | `scope` | keep temporarily | `scope: { type: "string", enum: ["user", "project"] }` |
| `src/config/config-tools.ts` | 151 | `scope` | keep temporarily | `scope: { type: "string", enum: ["user", "project"] }` |
| `src/config/config-tools.ts` | 191 | `scope` | keep temporarily | `scope: { type: "string", enum: ["user", "project"] }` |
| `src/config/config-tools.ts` | 302 | `scope` | keep temporarily | `scope: { type: "string", enum: ["user", "project"] }` |
| `src/config/config-tools.ts` | 347 | `scope` | keep temporarily | `scope: { type: "string", enum: ["user", "project"] }` |
| `src/config/config-tools.ts` | 464 | `scope` | keep temporarily | `scope: { type: "string", enum: ["user", "project"] },` |
| `src/config/config-tools.ts` | 517 | `scope` | keep temporarily | `scope: { type: "string", enum: ["user", "project"] }` |
| `src/config/provider-config-mutations.test.ts` | 414 | `scope` | delete | `scope: "user",` |
| `src/config/provider-config-mutations.test.ts` | 430 | `scope` | delete | `scope: "user",` |
| `src/config/provider-config-mutations.test.ts` | 444 | `scope` | delete | `scope: "user",` |
| `src/config/provider-config-mutations.test.ts` | 473 | `scope` | delete | `scope: "user",` |
| `src/config/provider-config-mutations.test.ts` | 545 | `scope` | delete | `scope: "user",` |
| `src/config/provider-config-mutations.ts` | 247 | `scope` | delete | `scope?: "user" \| "project";` |
| `src/config/provider-config-mutations.ts` | 251 | `scope` | delete | `return options.scope === "project"` |
| `src/config/runtime-config.ts` | 437 | `scope` | delete | `scope?: "user" \| "project";` |
| `src/config/runtime-config.ts` | 447 | `scope` | delete | `scope?: "user" \| "project";` |
| `src/config/runtime-config.ts` | 455 | `scope` | delete | `scope?: "user" \| "project";` |
| `src/config/runtime-config.ts` | 470 | `scope` | delete | `scope?: "user" \| "project";` |
| `src/config/runtime-config.ts` | 481 | `scope` | delete | `scope?: "user" \| "project";` |
| `src/config/runtime-config.ts` | 506 | `scope` | delete | `scope?: "user" \| "project";` |
| `src/config/runtime-config.ts` | 517 | `scope` | delete | `scope?: "user" \| "project";` |
| `src/config/runtime-config.ts` | 523 | `scope` | delete | `scope?: "user" \| "project";` |
| `src/config/runtime-config.ts` | 532 | `scope` | delete | `scope?: "user" \| "project";` |
| `src/config/runtime-config.ts` | 537 | `scope` | delete | `scope?: "user" \| "project";` |
| `src/config/runtime-config.ts` | 542 | `scope` | delete | `scope?: "user" \| "project";` |
| `src/config/runtime-config.ts` | 549 | `scope` | delete | `scope?: "user" \| "project";` |
| `src/config/runtime-config.ts` | 555 | `scope` | delete | `scope?: "user" \| "project";` |
| `src/config/runtime-config.ts` | 1402 | `scope` | delete | `const targetPath = options.input.scope === "project"` |
| `src/config/runtime-config.ts` | 1510 | `scope` | delete | `const targetPath = options.input.scope === "project"` |
| `src/config/runtime-config.ts` | 1545 | `scope` | delete | `scope?: "user" \| "project";` |
| `src/config/runtime-config.ts` | 1551 | `scope` | delete | `const targetPath = options.input.scope === "project"` |
| `src/config/runtime-config.ts` | 1580 | `scope` | delete | `scope?: "user" \| "project";` |
| `src/config/runtime-config.ts` | 1586 | `scope` | delete | `const targetPath = options.input.scope === "project"` |
| `src/config/runtime-config.ts` | 1615 | `scope` | delete | `scope?: "user" \| "project";` |
| `src/config/runtime-config.ts` | 1620 | `scope` | delete | `const targetPath = options.scope === "project"` |
| `src/config/runtime-config.ts` | 1649 | `scope` | delete | `const targetPath = options.input.scope === "project"` |
| `src/config/runtime-config.ts` | 1679 | `scope` | delete | `const targetPath = options.input.scope === "project"` |
| `src/config/runtime-config.ts` | 1712 | `scope` | delete | `const targetPath = options.input.scope === "project"` |
| `src/config/runtime-config.ts` | 1789 | `scope` | delete | `const targetPath = options.input.scope === "project"` |
| `src/config/runtime-config.ts` | 1845 | `scope` | delete | `const targetPath = options.input.scope === "project"` |
| `src/config/runtime-config.ts` | 1902 | `scope` | delete | `const targetPath = options.input.scope === "project"` |
| `src/config/runtime-config.ts` | 1947 | `scope` | delete | `const targetPath = options.input.scope === "project"` |
| `src/config/runtime-config.ts` | 1975 | `scope` | delete | `const targetPath = options.input.scope === "project"` |
| `src/config/runtime-config.ts` | 2016 | `scope` | delete | `const targetPath = options.input.scope === "project"` |
| `src/config/runtime-config.ts` | 2059 | `scope` | delete | `const targetPath = options.input.scope === "project"` |
| `src/config/runtime-config.ts` | 2123 | `scope` | delete | `if (input.scope === "project") {` |
| `src/config/runtime-config.ts` | 2246 | `scope` | keep temporarily | `validateScope(input.scope);` |
| `src/config/runtime-config.ts` | 2255 | `scope` | keep temporarily | `validateScope(input.scope);` |
| `src/config/runtime-config.ts` | 2272 | `scope` | keep temporarily | `validateScope(input.scope);` |
| `src/config/runtime-config.ts` | 2279 | `scope` | keep temporarily | `validateScope(input.scope);` |
| `src/config/runtime-config.ts` | 2287 | `scope` | keep temporarily | `validateScope(input.scope);` |
| `src/config/runtime-config.ts` | 2302 | `scope` | keep temporarily | `validateScope(input.scope);` |
| `src/config/runtime-config.ts` | 2318 | `scope` | keep temporarily | `validateScope(input.scope);` |
| `src/config/runtime-config.ts` | 2338 | `scope` | keep temporarily | `validateScope(input.scope);` |
| `src/config/runtime-config.ts` | 2350 | `scope` | keep temporarily | `validateScope(input.scope);` |
| `src/config/runtime-config.ts` | 2357 | `scope` | keep temporarily | `validateScope(input.scope);` |
| `src/config/runtime-config.ts` | 2370 | `scope` | keep temporarily | `validateScope(input.scope);` |
| `src/config/runtime-config.ts` | 2380 | `scope` | keep temporarily | `validateScope(input.scope);` |
| `src/config/runtime-config.ts` | 2387 | `scope` | delete | `function validateScope(scope: "user" \| "project" \| undefined): void {` |
| `src/config/runtime-config.ts` | 2388 | `scope` | keep temporarily | `if (scope !== undefined && scope !== "user" && scope !== "project") {` |
| `src/config/runtime-config.ts` | 2388 | `scope` | keep temporarily | `if (scope !== undefined && scope !== "user" && scope !== "project") {` |
| `src/config/runtime-config.ts` | 2388 | `scope` | keep temporarily | `if (scope !== undefined && scope !== "user" && scope !== "project") {` |
| `src/config/runtime-config.ts` | 2389 | `scope` | keep temporarily | `throw new Error("Expected scope user or project");` |
| `src/contracts/command-registry.ts` | 10 | `scope` | keep temporarily | `readonly scope: CommandScope;` |
| `src/contracts/command-registry.ts` | 19 | `scope` | keep temporarily | `scope?: CommandScope;` |
| `src/contracts/command-registry.ts` | 24 | `scope` | keep temporarily | `getCategories(scope?: CommandScope): readonly string[];` |
| `src/cron/cron-command.ts` | 37 | `scope` | keep temporarily | `const cronCommands = commandRegistry.list({ scope: "both", parent: "cron" });` |
| `src/onboarding/config-editor/runner.test.ts` | 420 | `scope` | keep temporarily | `kind: "config-scope",` |
| `src/onboarding/config-editor/runner.test.ts` | 421 | `scope` | keep temporarily | `scope: ["provider.route"],` |
| `src/onboarding/config-editor/runner.test.ts` | 517 | `scope` | keep temporarily | `kind: "config-scope",` |
| `src/onboarding/config-editor/runner.test.ts` | 518 | `scope` | keep temporarily | `scope: ["provider.credentialReference"],` |
| `src/onboarding/review/apply-executor.ts` | 60 | `scope` | keep temporarily | `readonly scope: ConfigScope;` |
| `src/onboarding/review/apply-executor.ts` | 287 | `scope` | keep temporarily | `scope: target.scope,` |
| `src/onboarding/review/apply-executor.ts` | 287 | `scope` | keep temporarily | `scope: target.scope,` |
| `src/onboarding/review/apply-executor.ts` | 305 | `scope` | keep temporarily | `scope: target.scope,` |
| `src/onboarding/review/apply-executor.ts` | 305 | `scope` | keep temporarily | `scope: target.scope,` |
| `src/onboarding/review/apply-executor.ts` | 356 | `scope` | keep temporarily | `scope: target.scope,` |
| `src/onboarding/review/apply-executor.ts` | 356 | `scope` | keep temporarily | `scope: target.scope,` |
| `src/onboarding/review/apply-executor.ts` | 375 | `scope` | keep temporarily | `scope: target.scope,` |
| `src/onboarding/review/apply-executor.ts` | 375 | `scope` | keep temporarily | `scope: target.scope,` |
| `src/onboarding/review/apply-executor.ts` | 392 | `scope` | keep temporarily | `scope: target.scope,` |
| `src/onboarding/review/apply-executor.ts` | 392 | `scope` | keep temporarily | `scope: target.scope,` |
| `src/onboarding/review/apply-executor.ts` | 409 | `scope` | keep temporarily | `scope: target.scope,` |
| `src/onboarding/review/apply-executor.ts` | 409 | `scope` | keep temporarily | `scope: target.scope,` |
| `src/onboarding/review/apply-executor.ts` | 468 | `scope` | keep temporarily | `const targetPath = operation.target?.kind === "config-scope" ? operation.target.path : undefined;` |
| `src/onboarding/review/apply-executor.ts` | 475 | `scope` | delete | `scope: "project",` |
| `src/onboarding/review/apply-executor.ts` | 483 | `scope` | delete | `scope: "user",` |
| `src/onboarding/review/apply-executor.ts` | 540 | `scope` | keep temporarily | `readonly scope?: ConfigScope;` |
| `src/onboarding/setup-apply-plan.test.ts` | 458 | `scope` | keep temporarily | `.filter((operation) => operation.target?.kind === "config-scope")` |
| `src/onboarding/setup-apply-plan.test.ts` | 461 | `scope` | keep temporarily | `operation.target?.kind === "config-scope" &&` |
| `src/onboarding/setup-apply-plan.test.ts` | 590 | `scope` | keep temporarily | `kind: "config-scope",` |
| `src/onboarding/setup-apply-plan.test.ts` | 591 | `scope` | keep temporarily | `scope: ["provider.credentialReference"],` |
| `src/onboarding/setup-apply-plan.ts` | 423 | `scope` | keep temporarily | `...(line.preserveUnrelatedConfig === true \|\| line.target?.kind === "config-scope"` |
| `src/onboarding/setup-copy.test.ts` | 318 | `scope` | keep temporarily | `expect(resolveSetupCopy("ar", "setupApply.operations.configPatch")).toContain(isolateLtr("{scope}"));` |
| `src/onboarding/setup-copy.ts` | 361 | `scope` | keep temporarily | `copy("setupApply.operations.configPatch", "Scoped config patch for {scope} in {configPath}.", "تعديل إعدادات محدود لـ {scope} داخل {configPath}.", ["{scope}", "{configPath}"],...` |
| `src/onboarding/setup-copy.ts` | 361 | `scope` | keep temporarily | `copy("setupApply.operations.configPatch", "Scoped config patch for {scope} in {configPath}.", "تعديل إعدادات محدود لـ {scope} داخل {configPath}.", ["{scope}", "{configPath}"],...` |
| `src/onboarding/setup-copy.ts` | 361 | `scope` | keep temporarily | `copy("setupApply.operations.configPatch", "Scoped config patch for {scope} in {configPath}.", "تعديل إعدادات محدود لـ {scope} داخل {configPath}.", ["{scope}", "{configPath}"],...` |
| `src/onboarding/setup-drafts.test.ts` | 172 | `scope` | keep temporarily | `kind: "config-scope",` |
| `src/onboarding/setup-drafts.test.ts` | 173 | `scope` | keep temporarily | `scope: ["model.provider", "model.id"],` |
| `src/onboarding/setup-drafts.test.ts` | 231 | `scope` | keep temporarily | `kind: "config-scope",` |
| `src/onboarding/setup-drafts.test.ts` | 232 | `scope` | keep temporarily | `scope: ["security.approvalMode"],` |
| `src/onboarding/setup-drafts.test.ts` | 236 | `scope` | keep temporarily | `kind: "config-scope",` |
| `src/onboarding/setup-drafts.test.ts` | 237 | `scope` | keep temporarily | `scope: ["skills.autonomy"],` |
| `src/onboarding/setup-drafts.test.ts` | 302 | `scope` | keep temporarily | `kind: "config-scope",` |
| `src/onboarding/setup-drafts.test.ts` | 303 | `scope` | keep temporarily | `scope: ["provider.route"],` |
| `src/onboarding/setup-drafts.test.ts` | 346 | `scope` | keep temporarily | `kind: "config-scope",` |
| `src/onboarding/setup-drafts.test.ts` | 347 | `scope` | keep temporarily | `scope: ["provider.credentialReference"],` |
| `src/onboarding/setup-drafts.test.ts` | 369 | `scope` | keep temporarily | `kind: "config-scope",` |
| `src/onboarding/setup-drafts.test.ts` | 370 | `scope` | keep temporarily | `scope: ["channels", "voice", "vision", "browser"],` |
| `src/onboarding/setup-drafts.test.ts` | 395 | `scope` | keep temporarily | `expect(bundle.drafts.some((draft) => draft.target.kind === "config-scope")).toBe(false);` |
| `src/onboarding/setup-drafts.test.ts` | 410 | `scope` | keep temporarily | `expect(bundle.drafts.some((draft) => draft.target.kind === "config-scope")).toBe(false);` |
| `src/onboarding/setup-drafts.ts` | 48 | `scope` | keep temporarily | `readonly kind: "config-scope";` |
| `src/onboarding/setup-drafts.ts` | 49 | `scope` | keep temporarily | `readonly scope: readonly SetupEditorPatchField[];` |
| `src/onboarding/setup-drafts.ts` | 193 | `scope` | keep temporarily | `scope: ["model.provider", "model.id"],` |
| `src/onboarding/setup-drafts.ts` | 230 | `scope` | keep temporarily | `scope: ["security.approvalMode"],` |
| `src/onboarding/setup-drafts.ts` | 247 | `scope` | keep temporarily | `scope: ["skills.autonomy"],` |
| `src/onboarding/setup-drafts.ts` | 277 | `scope` | keep temporarily | `scope: ["channels", "voice", "vision", "browser"],` |
| `src/onboarding/setup-drafts.ts` | 337 | `scope` | keep temporarily | `scope: action.patch?.fields ?? [],` |
| `src/onboarding/setup-drafts.ts` | 350 | `scope` | keep temporarily | `scope: action.patch?.fields ?? [],` |
| `src/onboarding/setup-drafts.ts` | 363 | `scope` | keep temporarily | `scope: action.patch?.fields ?? ["provider.route"],` |
| `src/onboarding/setup-drafts.ts` | 413 | `scope` | keep temporarily | `scope: action.patch?.fields ?? ["provider.credentialReference"],` |
| `src/onboarding/setup-drafts.ts` | 425 | `scope` | keep temporarily | `scope: action.patch?.fields ?? [],` |
| `src/onboarding/setup-drafts.ts` | 437 | `scope` | keep temporarily | `readonly scope: readonly SetupEditorPatchField[];` |
| `src/onboarding/setup-drafts.ts` | 449 | `scope` | keep temporarily | `kind: "config-scope",` |
| `src/onboarding/setup-drafts.ts` | 450 | `scope` | keep temporarily | `scope: input.scope,` |
| `src/onboarding/setup-drafts.ts` | 450 | `scope` | keep temporarily | `scope: input.scope,` |
| `src/onboarding/setup-drafts.ts` | 468 | `scope` | keep temporarily | `readonly scope?: readonly SetupEditorPatchField[];` |
| `src/onboarding/setup-drafts.ts` | 479 | `scope` | keep temporarily | `kind: "config-scope",` |
| `src/onboarding/setup-drafts.ts` | 480 | `scope` | keep temporarily | `scope: input.scope ?? ["providers.*.apiKeyEnv"],` |
| `src/onboarding/setup-drafts.ts` | 480 | `scope` | keep temporarily | `scope: input.scope ?? ["providers.*.apiKeyEnv"],` |
| `src/onboarding/setup-modules.test.ts` | 59 | `scope` | keep temporarily | `kind: "config-scope",` |
| `src/onboarding/setup-modules.test.ts` | 60 | `scope` | keep temporarily | `scope: ["model.provider", "model.id"],` |
| `src/onboarding/setup-modules.test.ts` | 135 | `scope` | keep temporarily | `kind: "config-scope",` |
| `src/onboarding/setup-modules.test.ts` | 136 | `scope` | keep temporarily | `scope: ["security.approvalMode"],` |
| `src/onboarding/setup-modules.test.ts` | 146 | `scope` | keep temporarily | `kind: "config-scope",` |
| `src/onboarding/setup-modules.test.ts` | 147 | `scope` | keep temporarily | `scope: ["skills.autonomy"],` |
| `src/onboarding/setup-modules.test.ts` | 303 | `scope` | keep temporarily | `expect(bundle.drafts.some((draft) => draft.target.kind === "config-scope")).toBe(false);` |
| `src/onboarding/setup-modules.ts` | 189 | `scope` | keep temporarily | `scope: ["model.provider", "model.id"],` |
| `src/onboarding/setup-modules.ts` | 298 | `scope` | keep temporarily | `scope: ["security.approvalMode"],` |
| `src/onboarding/setup-modules.ts` | 310 | `scope` | keep temporarily | `scope: ["skills.autonomy"],` |
| `src/onboarding/setup-modules.ts` | 318 | `scope` | keep temporarily | `scope: ["channels"],` |
| `src/onboarding/setup-modules.ts` | 340 | `scope` | keep temporarily | `scope: ["voice"],` |
| `src/onboarding/setup-modules.ts` | 355 | `scope` | keep temporarily | `scope: ["vision"],` |
| `src/onboarding/setup-modules.ts` | 368 | `scope` | keep temporarily | `scope: ["browser"],` |
| `src/onboarding/setup-modules.ts` | 425 | `scope` | keep temporarily | `readonly scope: readonly SetupEditorPatchField[];` |
| `src/onboarding/setup-modules.ts` | 467 | `scope` | keep temporarily | `scope: input.scope,` |
| `src/onboarding/setup-modules.ts` | 467 | `scope` | keep temporarily | `scope: input.scope,` |
| `src/onboarding/setup-modules.ts` | 483 | `scope` | keep temporarily | `readonly scope: readonly SetupEditorPatchField[];` |
| `src/onboarding/setup-modules.ts` | 524 | `scope` | keep temporarily | `scope: input.scope,` |
| `src/onboarding/setup-modules.ts` | 524 | `scope` | keep temporarily | `scope: input.scope,` |
| `src/onboarding/setup-modules.ts` | 585 | `scope` | keep temporarily | `readonly scope: readonly SetupEditorPatchField[];` |
| `src/onboarding/setup-modules.ts` | 599 | `scope` | keep temporarily | `target: configTarget(input.scope, input.configPath),` |
| `src/onboarding/setup-modules.ts` | 702 | `scope` | keep temporarily | `function configTarget(scope: readonly SetupEditorPatchField[], configPath: string \| undefined): SetupDraftTarget {` |
| `src/onboarding/setup-modules.ts` | 704 | `scope` | keep temporarily | `kind: "config-scope",` |
| `src/onboarding/setup-modules.ts` | 705 | `scope` | keep temporarily | `scope,` |
| `src/onboarding/setup-review-manifest.test.ts` | 93 | `scope` | keep temporarily | `expect(fileLines.every((line) => line.target?.kind === "config-scope")).toBe(true);` |
| `src/onboarding/setup-review-manifest.test.ts` | 156 | `scope` | keep temporarily | `kind: "config-scope",` |
| `src/onboarding/setup-review-manifest.test.ts` | 157 | `scope` | keep temporarily | `scope: ["model.provider", "model.id"],` |
| `src/onboarding/setup-review-manifest.test.ts` | 225 | `scope` | keep temporarily | `expect(manifest.lines.some((line) => line.target?.kind === "config-scope")).toBe(false);` |
| `src/onboarding/setup-review-manifest.test.ts` | 238 | `scope` | keep temporarily | `expect(manifest.lines.some((line) => line.target?.kind === "config-scope")).toBe(false);` |
| `src/onboarding/setup-review-manifest.ts` | 44 | `scope` | keep temporarily | `readonly kind: "config-scope";` |
| `src/onboarding/setup-review-manifest.ts` | 46 | `scope` | keep temporarily | `readonly scope: readonly string[];` |
| `src/onboarding/setup-review-manifest.ts` | 123 | `scope` | keep temporarily | `if (suppressionReason !== undefined && draft.target.kind === "config-scope" && draft.kind !== "diagnostic-blocker") {` |
| `src/onboarding/setup-review-manifest.ts` | 194 | `scope` | keep temporarily | `if (draft.target.kind === "config-scope" && !draft.readOnly) {` |
| `src/onboarding/setup-review-manifest.ts` | 266 | `scope` | keep temporarily | `...(draft.preserveUnrelatedConfig === true \|\| draft.target.kind === "config-scope"` |
| `src/onboarding/setup-review-manifest.ts` | 305 | `scope` | keep temporarily | `case "config-scope":` |
| `src/onboarding/setup-review-manifest.ts` | 307 | `scope` | keep temporarily | `kind: "config-scope",` |
| `src/onboarding/setup-review-manifest.ts` | 309 | `scope` | keep temporarily | `scope: target.scope,` |
| `src/onboarding/setup-review-manifest.ts` | 309 | `scope` | keep temporarily | `scope: target.scope,` |
| `src/providers/oauth/codex-oauth.test.ts` | 123 | `scope` | keep temporarily | `scope: "read write"` |
| `src/providers/oauth/codex-oauth.ts` | 28 | `scope` | keep temporarily | `scope?: string;` |
| `src/providers/oauth/codex-oauth.ts` | 79 | `scope` | keep temporarily | `scope: ""` |
| `src/providers/oauth/codex-oauth.ts` | 288 | `scope` | keep temporarily | `if (typeof obj.scope === "string" && obj.scope.length > 0) {` |
| `src/providers/oauth/codex-oauth.ts` | 288 | `scope` | keep temporarily | `if (typeof obj.scope === "string" && obj.scope.length > 0) {` |
| `src/providers/oauth/codex-oauth.ts` | 289 | `scope` | keep temporarily | `bundle.scopes = obj.scope.split(" ");` |
| `src/providers/provider-model-selection-flow.ts` | 376 | `scope` | keep temporarily | `// beyond this scope. Only the diagnostic is used.` |
| `src/runtime/create-runtime.ts` | 182 | `scope` | keep temporarily | `scope: ApprovalScope;` |
| `src/runtime/create-runtime.ts` | 190 | `scope` | keep temporarily | `scope: "once" \| "session";` |
| `src/runtime/create-runtime.ts` | 873 | `scope` | keep temporarily | `scope: input.scope` |
| `src/runtime/create-runtime.ts` | 873 | `scope` | keep temporarily | `scope: input.scope` |
| `src/security/workspace-approval-controller.ts` | 14 | `scope` | keep temporarily | `scope: "once" \| "session";` |
| `src/security/workspace-approval-controller.ts` | 34 | `scope` | keep temporarily | `scope: ApprovalScope;` |
| `src/security/workspace-approval-controller.ts` | 171 | `scope` | keep temporarily | `if (matched.scope === "once") {` |
| `src/security/workspace-approval-controller.ts` | 186 | `scope` | keep temporarily | `reason: matched.scope === "always"` |
| `src/security/workspace-approval-controller.ts` | 188 | `scope` | keep temporarily | `: matched.scope === "session"` |
| `src/security/workspace-approval-controller.ts` | 192 | `scope` | keep temporarily | `deterministicRule: matched.scope === "always"` |
| `src/security/workspace-approval-controller.ts` | 194 | `scope` | keep temporarily | `: matched.scope === "session"` |
| `src/security/workspace-approval-controller.ts` | 215 | `scope` | keep temporarily | `scope: ApprovalScope;` |
| `src/security/workspace-approval-controller.ts` | 217 | `scope` | keep temporarily | `if (input.scope === "always") {` |
| `src/security/workspace-approval-controller.ts` | 234 | `scope` | keep temporarily | `scope: input.scope` |
| `src/security/workspace-approval-controller.ts` | 234 | `scope` | keep temporarily | `scope: input.scope` |
| `src/security/workspace-approval-controller.ts` | 279 | `scope` | keep temporarily | `scope: grant.scope,` |
| `src/security/workspace-approval-controller.ts` | 279 | `scope` | keep temporarily | `scope: grant.scope,` |
| `src/security/workspace-approval-controller.ts` | 290 | `scope` | keep temporarily | `scope: "always",` |
| `src/security/workspace-approval-controller.ts` | 309 | `scope` | keep temporarily | `left: Pick<EphemeralApprovalGrant, "toolName" \| "riskClass" \| "targetKey" \| "scope">,` |
| `src/security/workspace-approval-controller.ts` | 310 | `scope` | keep temporarily | `right: Pick<EphemeralApprovalGrant, "toolName" \| "riskClass" \| "targetKey" \| "scope">` |
| `src/security/workspace-approval-controller.ts` | 315 | `scope` | keep temporarily | `left.scope === right.scope;` |
| `src/security/workspace-approval-controller.ts` | 315 | `scope` | keep temporarily | `left.scope === right.scope;` |
| `src/session/sqlite-session-db.ts` | 746 | `scope` | keep temporarily | `scope text,` |
| `src/taskflow/sqlite-taskflow-store.ts` | 392 | `scope` | keep temporarily | `reason, risk_class, tool_name, target_key, target_summary, scope,` |
| `src/taskflow/sqlite-taskflow-store.ts` | 409 | `scope` | keep temporarily | `gate.scope ?? null,` |
| `src/taskflow/sqlite-taskflow-store.ts` | 421 | `scope` | keep temporarily | `risk_class = ?, tool_name = ?, target_key = ?, target_summary = ?, scope = ?,` |
| `src/taskflow/sqlite-taskflow-store.ts` | 434 | `scope` | keep temporarily | `gate.scope ?? null,` |
| `src/taskflow/sqlite-taskflow-store.ts` | 752 | `scope` | keep temporarily | `scope: string \| null;` |
| `src/taskflow/sqlite-taskflow-store.ts` | 927 | `scope` | keep temporarily | `scope: row.scope ?? undefined,` |
| `src/taskflow/sqlite-taskflow-store.ts` | 927 | `scope` | keep temporarily | `scope: row.scope ?? undefined,` |
| `src/taskflow/types.ts` | 260 | `scope` | keep temporarily | `scope?: string;` |

## userConfigPath

| File | Line | Symbol | Proposed action | Occurrence |
|---|---:|---|---|---|
| `src/acp/server.ts` | 56 | `userConfigPath` | rename | `userConfigPath?: string;` |
| `src/acp/server.ts` | 65 | `userConfigPath` | rename | `userConfigPath?: string;` |
| `src/acp/server.ts` | 105 | `userConfigPath` | rename | `readonly #userConfigPath: string \| undefined;` |
| `src/acp/server.ts` | 127 | `userConfigPath` | rename | `this.#userConfigPath = options.userConfigPath;` |
| `src/acp/server.ts` | 127 | `userConfigPath` | rename | `this.#userConfigPath = options.userConfigPath;` |
| `src/acp/server.ts` | 748 | `userConfigPath` | rename | `userConfigPath: this.#userConfigPath,` |
| `src/acp/server.ts` | 748 | `userConfigPath` | rename | `userConfigPath: this.#userConfigPath,` |
| `src/acp/server.ts` | 764 | `userConfigPath` | rename | `userConfigPath: this.#userConfigPath,` |
| `src/acp/server.ts` | 764 | `userConfigPath` | rename | `userConfigPath: this.#userConfigPath,` |
| `src/acp/server.ts` | 770 | `userConfigPath` | rename | `userConfigPath: this.#userConfigPath,` |
| `src/acp/server.ts` | 770 | `userConfigPath` | rename | `userConfigPath: this.#userConfigPath,` |
| `src/acp/server.ts` | 820 | `userConfigPath` | rename | `userConfigPath: this.#userConfigPath,` |
| `src/acp/server.ts` | 820 | `userConfigPath` | rename | `userConfigPath: this.#userConfigPath,` |
| `src/channels/gateway-runner.ts` | 9 | `userConfigPath` | rename | `userConfigPath?: string;` |
| `src/cli/cli-model.test.ts` | 398 | `userConfigPath` | rename | `userConfigPath: configPath,` |
| `src/cli/cli.ts` | 169 | `userConfigPath` | rename | `userConfigPath?: string;` |
| `src/cli/cli.ts` | 323 | `userConfigPath` | rename | `userConfigPath: options.userConfigPath,` |
| `src/cli/cli.ts` | 323 | `userConfigPath` | rename | `userConfigPath: options.userConfigPath,` |
| `src/cli/cli.ts` | 347 | `userConfigPath` | rename | `userConfigPath: options.userConfigPath,` |
| `src/cli/cli.ts` | 347 | `userConfigPath` | rename | `userConfigPath: options.userConfigPath,` |
| `src/cli/cli.ts` | 768 | `userConfigPath` | rename | `userConfigPath: options.userConfigPath,` |
| `src/cli/cli.ts` | 768 | `userConfigPath` | rename | `userConfigPath: options.userConfigPath,` |
| `src/cli/cli.ts` | 1049 | `userConfigPath` | rename | `const targetPath = options.userConfigPath ?? resolveStateHome({ homeDir: options.homeDir }).configPath;` |
| `src/cli/cli.ts` | 1259 | `userConfigPath` | rename | `const targetPath = options.userConfigPath ?? resolveStateHome({ homeDir: options.homeDir }).configPath;` |
| `src/cli/cli.ts` | 2948 | `userConfigPath` | rename | `userConfigPath: options.userConfigPath,` |
| `src/cli/cli.ts` | 2948 | `userConfigPath` | rename | `userConfigPath: options.userConfigPath,` |
| `src/cli/gateway-commands.test.ts` | 990 | `userConfigPath` | rename | `it("writes to userConfigPath when overridden", async () => {` |
| `src/cli/gateway-commands.test.ts` | 992 | `userConfigPath` | rename | `const result = await runChannelsEnable({ workspaceRoot: tmpDir, homeDir: tmpDir, userConfigPath: customPath, channel: "telegram" });` |
| `src/cli/gateway-commands.ts` | 64 | `userConfigPath` | rename | `userConfigPath?: string;` |
| `src/cli/gateway-commands.ts` | 715 | `userConfigPath` | rename | `return options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");` |
| `src/cli/model-setup-codex.ts` | 18 | `userConfigPath` | rename | `userConfigPath?: string;` |
| `src/cli/model-setup.ts` | 338 | `userConfigPath` | rename | `: options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");` |
| `src/config/config-tools.ts` | 24 | `userConfigPath` | rename | `userConfigPath?: string;` |
| `src/config/provider-config-mutations.test.ts` | 584 | `userConfigPath` | rename | `userConfigPath: join(tmpDir, ".estacoda", "config.json"),` |
| `src/config/provider-config-mutations.test.ts` | 597 | `userConfigPath` | rename | `userConfigPath: join(tmpDir, ".estacoda", "config.json"),` |
| `src/config/provider-config-mutations.test.ts` | 633 | `userConfigPath` | rename | `userConfigPath: join(tmpDir, ".estacoda", "config.json"),` |
| `src/config/provider-config-mutations.test.ts` | 646 | `userConfigPath` | rename | `userConfigPath: join(tmpDir, ".estacoda", "config.json"),` |
| `src/config/provider-config-mutations.test.ts` | 718 | `userConfigPath` | rename | `userConfigPath: join(tmpDir, ".estacoda", "config.json"),` |
| `src/config/provider-config-mutations.test.ts` | 759 | `userConfigPath` | rename | `userConfigPath: join(tmpDir, ".estacoda", "config.json"),` |
| `src/config/provider-config-mutations.test.ts` | 776 | `userConfigPath` | rename | `userConfigPath: join(tmpDir, ".estacoda", "config.json"),` |
| `src/config/provider-config-mutations.test.ts` | 798 | `userConfigPath` | rename | `userConfigPath: join(tmpDir, ".estacoda", "config.json"),` |
| `src/config/provider-config-mutations.test.ts` | 812 | `userConfigPath` | rename | `userConfigPath: join(tmpDir, ".estacoda", "config.json"),` |
| `src/config/provider-config-mutations.test.ts` | 826 | `userConfigPath` | rename | `userConfigPath: join(tmpDir, ".estacoda", "config.json"),` |
| `src/config/provider-config-mutations.ts` | 245 | `userConfigPath` | rename | `userConfigPath?: string;` |
| `src/config/provider-config-mutations.ts` | 253 | `userConfigPath` | rename | `: options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");` |
| `src/config/runtime-config.test.ts` | 77 | `userConfigPath` | rename | `userConfigPath: join(workspace, "nonexistent-user-config.json"),` |
| `src/config/runtime-config.test.ts` | 97 | `userConfigPath` | rename | `userConfigPath: join(workspace, "nonexistent-user-config.json"),` |
| `src/config/runtime-config.test.ts` | 122 | `userConfigPath` | rename | `const loaded = await loadRuntimeConfig({ workspaceRoot: workspace, userConfigPath: join(workspace, "nonexistent-user-config.json"), projectConfigTrust: "trusted" });` |
| `src/config/runtime-config.test.ts` | 137 | `userConfigPath` | rename | `const loaded = await loadRuntimeConfig({ workspaceRoot: workspace, userConfigPath: join(workspace, "nonexistent-user-config.json"), projectConfigTrust: "trusted" });` |
| `src/config/runtime-config.test.ts` | 161 | `userConfigPath` | rename | `const loaded = await loadRuntimeConfig({ workspaceRoot: workspace, userConfigPath: join(workspace, "nonexistent-user-config.json"), projectConfigTrust: "trusted" });` |
| `src/config/runtime-config.test.ts` | 176 | `userConfigPath` | rename | `const loaded = await loadRuntimeConfig({ workspaceRoot: workspace, userConfigPath: join(workspace, "nonexistent-user-config.json"), projectConfigTrust: "trusted" });` |
| `src/config/runtime-config.test.ts` | 191 | `userConfigPath` | rename | `const loaded = await loadRuntimeConfig({ workspaceRoot: workspace, userConfigPath: join(workspace, "nonexistent-user-config.json"), projectConfigTrust: "trusted" });` |
| `src/config/runtime-config.test.ts` | 206 | `userConfigPath` | rename | `const loaded = await loadRuntimeConfig({ workspaceRoot: workspace, userConfigPath: join(workspace, "nonexistent-user-config.json"), projectConfigTrust: "trusted" });` |
| `src/config/runtime-config.test.ts` | 241 | `userConfigPath` | rename | `userConfigPath: join(workspace, "nonexistent-user-config.json"),` |
| `src/config/runtime-config.test.ts` | 281 | `userConfigPath` | rename | `userConfigPath: join(workspace, "nonexistent-user-config.json"),` |
| `src/config/runtime-config.test.ts` | 308 | `userConfigPath` | rename | `userConfigPath: join(workspace, "nonexistent-user-config.json"),` |
| `src/config/runtime-config.test.ts` | 327 | `userConfigPath` | rename | `userConfigPath: join(workspace, "nonexistent-user-config.json"),` |
| `src/config/runtime-config.test.ts` | 351 | `userConfigPath` | rename | `userConfigPath: join(workspace, "nonexistent-user-config.json"),` |
| `src/config/runtime-config.test.ts` | 376 | `userConfigPath` | rename | `userConfigPath: join(workspace, "nonexistent-user-config.json"),` |
| `src/config/runtime-config.test.ts` | 429 | `userConfigPath` | rename | `userConfigPath: join(workspace, "nonexistent-user-config.json"),` |
| `src/config/runtime-config.test.ts` | 468 | `userConfigPath` | rename | `userConfigPath: join(workspace, "nonexistent-user-config.json"),` |
| `src/config/runtime-config.test.ts` | 599 | `userConfigPath` | rename | `userConfigPath: join(workspace, "nonexistent-user-config.json")` |
| `src/config/runtime-config.test.ts` | 617 | `userConfigPath` | rename | `userConfigPath: join(workspace, "nonexistent-user-config.json"),` |
| `src/config/runtime-config.test.ts` | 635 | `userConfigPath` | rename | `userConfigPath: join(workspace, "nonexistent-user-config.json"),` |
| `src/config/runtime-config.test.ts` | 682 | `userConfigPath` | rename | `userConfigPath: join(workspace, ".estacoda", "config.json"),` |
| `src/config/runtime-config.test.ts` | 706 | `userConfigPath` | rename | `userConfigPath: join(workspace, ".estacoda", "config.json"),` |
| `src/config/runtime-config.test.ts` | 729 | `userConfigPath` | rename | `userConfigPath: join(workspace, ".estacoda", "config.json"),` |
| `src/config/runtime-config.test.ts` | 753 | `userConfigPath` | rename | `userConfigPath: join(workspace, ".estacoda", "config.json"),` |
| `src/config/runtime-config.test.ts` | 775 | `userConfigPath` | rename | `userConfigPath: join(workspace, ".estacoda", "config.json"),` |
| `src/config/runtime-config.test.ts` | 798 | `userConfigPath` | rename | `userConfigPath: join(workspace, ".estacoda", "config.json"),` |
| `src/config/runtime-config.test.ts` | 824 | `userConfigPath` | rename | `userConfigPath: join(workspace, ".estacoda", "config.json"),` |
| `src/config/runtime-config.test.ts` | 882 | `userConfigPath` | rename | `userConfigPath: join(workspace, ".estacoda", "config.json"),` |
| `src/config/runtime-config.ts` | 561 | `userConfigPath` | rename | `userConfigPath?: string;` |
| `src/config/runtime-config.ts` | 572 | `userConfigPath` | rename | `options.userConfigPath ?? stateHome.configPath` |
| `src/config/runtime-config.ts` | 1393 | `userConfigPath` | rename | `userConfigPath?: string;` |
| `src/config/runtime-config.ts` | 1404 | `userConfigPath` | rename | `: options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");` |
| `src/config/runtime-config.ts` | 1502 | `userConfigPath` | rename | `userConfigPath?: string;` |
| `src/config/runtime-config.ts` | 1512 | `userConfigPath` | rename | `: options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");` |
| `src/config/runtime-config.ts` | 1539 | `userConfigPath` | rename | `userConfigPath?: string;` |
| `src/config/runtime-config.ts` | 1553 | `userConfigPath` | rename | `: options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");` |
| `src/config/runtime-config.ts` | 1576 | `userConfigPath` | rename | `userConfigPath?: string;` |
| `src/config/runtime-config.ts` | 1588 | `userConfigPath` | rename | `: options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");` |
| `src/config/runtime-config.ts` | 1613 | `userConfigPath` | rename | `userConfigPath?: string;` |
| `src/config/runtime-config.ts` | 1622 | `userConfigPath` | rename | `: options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");` |
| `src/config/runtime-config.ts` | 1641 | `userConfigPath` | rename | `userConfigPath?: string;` |
| `src/config/runtime-config.ts` | 1651 | `userConfigPath` | rename | `: options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");` |
| `src/config/runtime-config.ts` | 1671 | `userConfigPath` | rename | `userConfigPath?: string;` |
| `src/config/runtime-config.ts` | 1681 | `userConfigPath` | rename | `: options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");` |
| `src/config/runtime-config.ts` | 1703 | `userConfigPath` | rename | `userConfigPath?: string;` |
| `src/config/runtime-config.ts` | 1714 | `userConfigPath` | rename | `: options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");` |
| `src/config/runtime-config.ts` | 1780 | `userConfigPath` | rename | `userConfigPath?: string;` |
| `src/config/runtime-config.ts` | 1791 | `userConfigPath` | rename | `: options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");` |
| `src/config/runtime-config.ts` | 1837 | `userConfigPath` | rename | `userConfigPath?: string;` |
| `src/config/runtime-config.ts` | 1847 | `userConfigPath` | rename | `: options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");` |
| `src/config/runtime-config.ts` | 1894 | `userConfigPath` | rename | `userConfigPath?: string;` |
| `src/config/runtime-config.ts` | 1904 | `userConfigPath` | rename | `: options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");` |
| `src/config/runtime-config.ts` | 1939 | `userConfigPath` | rename | `userConfigPath?: string;` |
| `src/config/runtime-config.ts` | 1949 | `userConfigPath` | rename | `: options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");` |
| `src/config/runtime-config.ts` | 1967 | `userConfigPath` | rename | `userConfigPath?: string;` |
| `src/config/runtime-config.ts` | 1977 | `userConfigPath` | rename | `: options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");` |
| `src/config/runtime-config.ts` | 2008 | `userConfigPath` | rename | `userConfigPath?: string;` |
| `src/config/runtime-config.ts` | 2018 | `userConfigPath` | rename | `: options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");` |
| `src/config/runtime-config.ts` | 2050 | `userConfigPath` | rename | `userConfigPath?: string;` |
| `src/config/runtime-config.ts` | 2061 | `userConfigPath` | rename | `: options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");` |
| `src/config/runtime-config.ts` | 2111 | `userConfigPath` | rename | `userConfigPath?: string;` |
| `src/config/runtime-config.ts` | 2126 | `userConfigPath` | rename | `const targetPath = options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");` |
| `src/config/runtime-config.ts` | 2158 | `userConfigPath` | rename | `userConfigPath?: string;` |
| `src/config/runtime-config.ts` | 2170 | `userConfigPath` | rename | `const targetPath = options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json");` |
| `src/gateway/supervisor.test.ts` | 206 | `userConfigPath` | rename | `userConfigPath: join(tmpDir, ".estacoda", "config.json"),` |
| `src/gateway/supervisor.ts` | 94 | `userConfigPath` | rename | `userConfigPath?: string;` |
| `src/gateway/supervisor.ts` | 107 | `userConfigPath` | rename | `userConfigPath: input.userConfigPath,` |
| `src/gateway/supervisor.ts` | 107 | `userConfigPath` | rename | `userConfigPath: input.userConfigPath,` |
| `src/gateway/supervisor.ts` | 345 | `userConfigPath` | rename | `userConfigPath: options.userConfigPath,` |
| `src/gateway/supervisor.ts` | 345 | `userConfigPath` | rename | `userConfigPath: options.userConfigPath,` |
| `src/gateway/supervisor.ts` | 500 | `userConfigPath` | rename | `userConfigPath: options.userConfigPath,` |
| `src/gateway/supervisor.ts` | 500 | `userConfigPath` | rename | `userConfigPath: options.userConfigPath,` |
| `src/gateway/supervisor.ts` | 856 | `userConfigPath` | rename | `userConfigPath: options.userConfigPath,` |
| `src/gateway/supervisor.ts` | 856 | `userConfigPath` | rename | `userConfigPath: options.userConfigPath,` |
| `src/gateway/supervisor.ts` | 913 | `userConfigPath` | rename | `userConfigPath: options.userConfigPath,` |
| `src/gateway/supervisor.ts` | 913 | `userConfigPath` | rename | `userConfigPath: options.userConfigPath,` |
| `src/gateway/supervisor.ts` | 1036 | `userConfigPath` | rename | `userConfigPath: options.userConfigPath,` |
| `src/gateway/supervisor.ts` | 1036 | `userConfigPath` | rename | `userConfigPath: options.userConfigPath,` |
| `src/onboarding/config-editor/runner.ts` | 480 | `userConfigPath` | rename | `configPath: options.userConfigPath ?? initialDecision.state.configSources[0] ?? stateHome.configPath,` |
| `src/onboarding/config-editor/runner.ts` | 497 | `userConfigPath` | rename | `configPath: options.userConfigPath ?? initialDecision.state.configSources[0] ?? stateHome.configPath,` |
| `src/onboarding/config-editor/runner.ts` | 823 | `userConfigPath` | rename | `configPath: options.userConfigPath ?? initialDecision.state.configSources[0] ?? stateHome.configPath,` |
| `src/onboarding/config-editor/runner.ts` | 1007 | `userConfigPath` | rename | `configPath: options.userConfigPath ?? initialDecision.state.configSources[0] ?? stateHome.configPath,` |
| `src/onboarding/first-run/runner.ts` | 384 | `userConfigPath` | rename | `configPath: options.userConfigPath ?? stateHome.configPath,` |
| `src/onboarding/review/apply-executor.ts` | 46 | `userConfigPath` | rename | `readonly userConfigPath?: string;` |
| `src/onboarding/review/apply-executor.ts` | 58 | `userConfigPath` | rename | `readonly userConfigPath?: string;` |
| `src/onboarding/review/apply-executor.ts` | 154 | `userConfigPath` | rename | `userConfigPath: options.userConfigPath,` |
| `src/onboarding/review/apply-executor.ts` | 154 | `userConfigPath` | rename | `userConfigPath: options.userConfigPath,` |
| `src/onboarding/review/apply-executor.ts` | 481 | `userConfigPath` | rename | `userConfigPath: targetPath ?? options.userConfigPath,` |
| `src/onboarding/review/apply-executor.ts` | 481 | `userConfigPath` | rename | `userConfigPath: targetPath ?? options.userConfigPath,` |
| `src/onboarding/review/apply-executor.ts` | 546 | `userConfigPath` | rename | `userConfigPath: options.userConfigPath,` |
| `src/onboarding/review/apply-executor.ts` | 546 | `userConfigPath` | rename | `userConfigPath: options.userConfigPath,` |
| `src/onboarding/setup-entry-state.ts` | 64 | `userConfigPath` | rename | `readonly userConfigPath?: string;` |
| `src/onboarding/setup-entry-state.ts` | 103 | `userConfigPath` | rename | `userConfigPath: options.userConfigPath,` |
| `src/onboarding/setup-entry-state.ts` | 103 | `userConfigPath` | rename | `userConfigPath: options.userConfigPath,` |
| `src/onboarding/setup-entry-state.ts` | 259 | `userConfigPath` | rename | `user: options.userConfigPath ?? join(options.homeDir ?? process.env.HOME ?? "", ".estacoda", "config.json"),` |
| `src/onboarding/verification.ts` | 19 | `userConfigPath` | rename | `userConfigPath?: string;` |
| `src/runtime/create-runtime.ts` | 115 | `userConfigPath` | rename | `userConfigPath?: string;` |
| `src/runtime/create-runtime.ts` | 434 | `userConfigPath` | rename | `userConfigPath: options.userConfigPath,` |
| `src/runtime/create-runtime.ts` | 434 | `userConfigPath` | rename | `userConfigPath: options.userConfigPath,` |
| `src/runtime/create-runtime.ts` | 993 | `userConfigPath` | rename | `userConfigPath: options.userConfigPath,` |
| `src/runtime/create-runtime.ts` | 993 | `userConfigPath` | rename | `userConfigPath: options.userConfigPath,` |
| `src/runtime/runtime-fingerprint.test.ts` | 57 | `userConfigPath` | rename | `userConfigPath?: string;` |
| `src/runtime/runtime-fingerprint.test.ts` | 59 | `userConfigPath` | rename | `}>): Required<Omit<Parameters<typeof computeRuntimeFingerprint>[1], "userMemoryRoot" \| "projectMemoryRoot" \| "trustStorePath" \| "userConfigPath" \| "projectConfigPath">> & Partia...` |
| `src/runtime/runtime-fingerprint.test.ts` | 59 | `userConfigPath` | rename | `}>): Required<Omit<Parameters<typeof computeRuntimeFingerprint>[1], "userMemoryRoot" \| "projectMemoryRoot" \| "trustStorePath" \| "userConfigPath" \| "projectConfigPath">> & Partia...` |
| `src/runtime/runtime-fingerprint.test.ts` | 707 | `userConfigPath` | rename | `fakeOptions({ userConfigPath: "/other/user.config.js" })` |
| `src/runtime/runtime-fingerprint.test.ts` | 709 | `userConfigPath` | rename | `expect(fp2.userConfigPath).toBe("/other/user.config.js");` |
| `src/runtime/runtime-fingerprint.ts` | 62 | `userConfigPath` | rename | `userConfigPath?: string;` |
| `src/runtime/runtime-fingerprint.ts` | 81 | `userConfigPath` | rename | `userConfigPath?: string;` |
| `src/runtime/runtime-fingerprint.ts` | 131 | `userConfigPath` | rename | `userConfigPath: options.userConfigPath,` |
| `src/runtime/runtime-fingerprint.ts` | 131 | `userConfigPath` | rename | `userConfigPath: options.userConfigPath,` |

## projectConfigPath

| File | Line | Symbol | Proposed action | Occurrence |
|---|---:|---|---|---|
| `scripts/provider-hardening.ts` | 40 | `projectConfigPath` | delete | `const projectConfigPath = join(workspaceRoot, ".estacoda", "config.json");` |
| `scripts/provider-hardening.ts` | 56 | `projectConfigPath` | delete | `const originalProjectConfig = await readOptional(projectConfigPath);` |
| `scripts/provider-hardening.ts` | 238 | `projectConfigPath` | delete | `await rm(projectConfigPath, { force: true });` |
| `scripts/provider-hardening.ts` | 242 | `projectConfigPath` | delete | `await writeFile(projectConfigPath, original, "utf8");` |
| `src/acp/server.ts` | 57 | `projectConfigPath` | delete | `projectConfigPath?: string;` |
| `src/acp/server.ts` | 66 | `projectConfigPath` | delete | `projectConfigPath?: string;` |
| `src/acp/server.ts` | 106 | `projectConfigPath` | delete | `readonly #projectConfigPath: string \| undefined;` |
| `src/acp/server.ts` | 128 | `projectConfigPath` | delete | `this.#projectConfigPath = options.projectConfigPath;` |
| `src/acp/server.ts` | 128 | `projectConfigPath` | delete | `this.#projectConfigPath = options.projectConfigPath;` |
| `src/acp/server.ts` | 749 | `projectConfigPath` | delete | `projectConfigPath: this.#projectConfigPath,` |
| `src/acp/server.ts` | 749 | `projectConfigPath` | delete | `projectConfigPath: this.#projectConfigPath,` |
| `src/acp/server.ts` | 765 | `projectConfigPath` | delete | `projectConfigPath: this.#projectConfigPath` |
| `src/acp/server.ts` | 765 | `projectConfigPath` | delete | `projectConfigPath: this.#projectConfigPath` |
| `src/acp/server.ts` | 771 | `projectConfigPath` | delete | `projectConfigPath: this.#projectConfigPath` |
| `src/acp/server.ts` | 771 | `projectConfigPath` | delete | `projectConfigPath: this.#projectConfigPath` |
| `src/acp/server.ts` | 821 | `projectConfigPath` | delete | `projectConfigPath: this.#projectConfigPath` |
| `src/acp/server.ts` | 821 | `projectConfigPath` | delete | `projectConfigPath: this.#projectConfigPath` |
| `src/channels/gateway-runner.ts` | 10 | `projectConfigPath` | delete | `projectConfigPath?: string;` |
| `src/cli/cli-model.test.ts` | 1426 | `projectConfigPath` | delete | `const projectConfigPath = join(tmpDir, "project-config.json");` |
| `src/cli/cli-model.test.ts` | 1427 | `projectConfigPath` | delete | `await writeFile(projectConfigPath, JSON.stringify({` |
| `src/cli/cli-model.test.ts` | 1435 | `projectConfigPath` | delete | `projectConfigPath,` |
| `src/cli/cli-model.test.ts` | 1448 | `projectConfigPath` | delete | `projectConfigPath,` |
| `src/cli/cli.ts` | 170 | `projectConfigPath` | delete | `projectConfigPath?: string;` |
| `src/cli/cli.ts` | 324 | `projectConfigPath` | delete | `projectConfigPath: options.projectConfigPath,` |
| `src/cli/cli.ts` | 324 | `projectConfigPath` | delete | `projectConfigPath: options.projectConfigPath,` |
| `src/cli/cli.ts` | 348 | `projectConfigPath` | delete | `projectConfigPath: options.projectConfigPath,` |
| `src/cli/cli.ts` | 348 | `projectConfigPath` | delete | `projectConfigPath: options.projectConfigPath,` |
| `src/cli/cli.ts` | 769 | `projectConfigPath` | delete | `projectConfigPath: options.projectConfigPath,` |
| `src/cli/cli.ts` | 769 | `projectConfigPath` | delete | `projectConfigPath: options.projectConfigPath,` |
| `src/cli/cli.ts` | 2949 | `projectConfigPath` | delete | `projectConfigPath: options.projectConfigPath` |
| `src/cli/cli.ts` | 2949 | `projectConfigPath` | delete | `projectConfigPath: options.projectConfigPath` |
| `src/cli/gateway-commands.test.ts` | 999 | `projectConfigPath` | delete | `it("does not write to projectConfigPath", async () => {` |
| `src/cli/gateway-commands.test.ts` | 1003 | `projectConfigPath` | delete | `const result = await runChannelsEnable({ workspaceRoot: tmpDir, homeDir: tmpDir, projectConfigPath: projectPath, channel: "telegram" });` |
| `src/cli/gateway-commands.ts` | 65 | `projectConfigPath` | delete | `projectConfigPath?: string;` |
| `src/cli/model-setup-codex.ts` | 19 | `projectConfigPath` | delete | `projectConfigPath?: string;` |
| `src/cli/model-setup.ts` | 337 | `projectConfigPath` | delete | `? options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")` |
| `src/config/config-tools.ts` | 25 | `projectConfigPath` | delete | `projectConfigPath?: string;` |
| `src/config/provider-config-mutations.ts` | 246 | `projectConfigPath` | delete | `projectConfigPath?: string;` |
| `src/config/provider-config-mutations.ts` | 252 | `projectConfigPath` | delete | `? options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")` |
| `src/config/runtime-config.test.ts` | 499 | `projectConfigPath` | delete | `const projectConfigPath = join(workspace, ".estacoda", "config.json");` |
| `src/config/runtime-config.test.ts` | 500 | `projectConfigPath` | delete | `await writeFile(projectConfigPath, JSON.stringify({` |
| `src/config/runtime-config.test.ts` | 513 | `projectConfigPath` | delete | `const projectConfigPath = join(workspace, ".estacoda", "config.json");` |
| `src/config/runtime-config.test.ts` | 514 | `projectConfigPath` | delete | `await writeFile(projectConfigPath, JSON.stringify({` |
| `src/config/runtime-config.test.ts` | 527 | `projectConfigPath` | delete | `const projectConfigPath = join(workspace, ".estacoda", "config.json");` |
| `src/config/runtime-config.test.ts` | 528 | `projectConfigPath` | delete | `await writeFile(projectConfigPath, "this is not json");` |
| `src/config/runtime-config.test.ts` | 539 | `projectConfigPath` | delete | `const projectConfigPath = join(workspace, ".estacoda", "config.json");` |
| `src/config/runtime-config.test.ts` | 540 | `projectConfigPath` | delete | `await writeFile(projectConfigPath, JSON.stringify({` |
| `src/config/runtime-config.test.ts` | 560 | `projectConfigPath` | delete | `const projectConfigPath = join(workspace, ".estacoda", "config.json");` |
| `src/config/runtime-config.test.ts` | 561 | `projectConfigPath` | delete | `await writeFile(projectConfigPath, JSON.stringify({` |
| `src/config/runtime-config.test.ts` | 575 | `projectConfigPath` | delete | `const projectConfigPath = join(workspace, ".estacoda", "config.json");` |
| `src/config/runtime-config.test.ts` | 576 | `projectConfigPath` | delete | `await writeFile(projectConfigPath, JSON.stringify({` |
| `src/config/runtime-config.test.ts` | 592 | `projectConfigPath` | delete | `const projectConfigPath = join(workspace, ".estacoda", "config.json");` |
| `src/config/runtime-config.test.ts` | 593 | `projectConfigPath` | delete | `await writeFile(projectConfigPath, JSON.stringify({` |
| `src/config/runtime-config.test.ts` | 610 | `projectConfigPath` | delete | `const projectConfigPath = join(workspace, ".estacoda", "config.json");` |
| `src/config/runtime-config.test.ts` | 611 | `projectConfigPath` | delete | `await writeFile(projectConfigPath, JSON.stringify({` |
| `src/config/runtime-config.test.ts` | 628 | `projectConfigPath` | delete | `const projectConfigPath = join(workspace, ".estacoda", "config.json");` |
| `src/config/runtime-config.test.ts` | 629 | `projectConfigPath` | delete | `await writeFile(projectConfigPath, JSON.stringify({` |
| `src/config/runtime-config.ts` | 562 | `projectConfigPath` | delete | `projectConfigPath?: string;` |
| `src/config/runtime-config.ts` | 575 | `projectConfigPath` | delete | `sources.push(options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json"));` |
| `src/config/runtime-config.ts` | 1394 | `projectConfigPath` | delete | `projectConfigPath?: string;` |
| `src/config/runtime-config.ts` | 1403 | `projectConfigPath` | delete | `? options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")` |
| `src/config/runtime-config.ts` | 1503 | `projectConfigPath` | delete | `projectConfigPath?: string;` |
| `src/config/runtime-config.ts` | 1511 | `projectConfigPath` | delete | `? options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")` |
| `src/config/runtime-config.ts` | 1540 | `projectConfigPath` | delete | `projectConfigPath?: string;` |
| `src/config/runtime-config.ts` | 1552 | `projectConfigPath` | delete | `? options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")` |
| `src/config/runtime-config.ts` | 1577 | `projectConfigPath` | delete | `projectConfigPath?: string;` |
| `src/config/runtime-config.ts` | 1587 | `projectConfigPath` | delete | `? options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")` |
| `src/config/runtime-config.ts` | 1614 | `projectConfigPath` | delete | `projectConfigPath?: string;` |
| `src/config/runtime-config.ts` | 1621 | `projectConfigPath` | delete | `? options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")` |
| `src/config/runtime-config.ts` | 1642 | `projectConfigPath` | delete | `projectConfigPath?: string;` |
| `src/config/runtime-config.ts` | 1650 | `projectConfigPath` | delete | `? options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")` |
| `src/config/runtime-config.ts` | 1672 | `projectConfigPath` | delete | `projectConfigPath?: string;` |
| `src/config/runtime-config.ts` | 1680 | `projectConfigPath` | delete | `? options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")` |
| `src/config/runtime-config.ts` | 1704 | `projectConfigPath` | delete | `projectConfigPath?: string;` |
| `src/config/runtime-config.ts` | 1713 | `projectConfigPath` | delete | `? options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")` |
| `src/config/runtime-config.ts` | 1781 | `projectConfigPath` | delete | `projectConfigPath?: string;` |
| `src/config/runtime-config.ts` | 1790 | `projectConfigPath` | delete | `? options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")` |
| `src/config/runtime-config.ts` | 1838 | `projectConfigPath` | delete | `projectConfigPath?: string;` |
| `src/config/runtime-config.ts` | 1846 | `projectConfigPath` | delete | `? options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")` |
| `src/config/runtime-config.ts` | 1895 | `projectConfigPath` | delete | `projectConfigPath?: string;` |
| `src/config/runtime-config.ts` | 1903 | `projectConfigPath` | delete | `? options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")` |
| `src/config/runtime-config.ts` | 1940 | `projectConfigPath` | delete | `projectConfigPath?: string;` |
| `src/config/runtime-config.ts` | 1948 | `projectConfigPath` | delete | `? options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")` |
| `src/config/runtime-config.ts` | 1968 | `projectConfigPath` | delete | `projectConfigPath?: string;` |
| `src/config/runtime-config.ts` | 1976 | `projectConfigPath` | delete | `? options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")` |
| `src/config/runtime-config.ts` | 2009 | `projectConfigPath` | delete | `projectConfigPath?: string;` |
| `src/config/runtime-config.ts` | 2017 | `projectConfigPath` | delete | `? options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")` |
| `src/config/runtime-config.ts` | 2051 | `projectConfigPath` | delete | `projectConfigPath?: string;` |
| `src/config/runtime-config.ts` | 2060 | `projectConfigPath` | delete | `? options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json")` |
| `src/config/runtime-config.ts` | 2112 | `projectConfigPath` | delete | `projectConfigPath?: string;` |
| `src/config/runtime-config.ts` | 2159 | `projectConfigPath` | delete | `projectConfigPath?: string;` |
| `src/gateway/supervisor.test.ts` | 207 | `projectConfigPath` | delete | `projectConfigPath: join(tmpDir, ".estacoda", "project-config.json"),` |
| `src/gateway/supervisor.ts` | 95 | `projectConfigPath` | delete | `projectConfigPath?: string;` |
| `src/gateway/supervisor.ts` | 108 | `projectConfigPath` | delete | `projectConfigPath: input.projectConfigPath,` |
| `src/gateway/supervisor.ts` | 108 | `projectConfigPath` | delete | `projectConfigPath: input.projectConfigPath,` |
| `src/gateway/supervisor.ts` | 346 | `projectConfigPath` | delete | `projectConfigPath: options.projectConfigPath,` |
| `src/gateway/supervisor.ts` | 346 | `projectConfigPath` | delete | `projectConfigPath: options.projectConfigPath,` |
| `src/gateway/supervisor.ts` | 501 | `projectConfigPath` | delete | `projectConfigPath: options.projectConfigPath,` |
| `src/gateway/supervisor.ts` | 501 | `projectConfigPath` | delete | `projectConfigPath: options.projectConfigPath,` |
| `src/gateway/supervisor.ts` | 857 | `projectConfigPath` | delete | `projectConfigPath: options.projectConfigPath,` |
| `src/gateway/supervisor.ts` | 857 | `projectConfigPath` | delete | `projectConfigPath: options.projectConfigPath,` |
| `src/gateway/supervisor.ts` | 914 | `projectConfigPath` | delete | `projectConfigPath: options.projectConfigPath,` |
| `src/gateway/supervisor.ts` | 914 | `projectConfigPath` | delete | `projectConfigPath: options.projectConfigPath,` |
| `src/gateway/supervisor.ts` | 1037 | `projectConfigPath` | delete | `projectConfigPath: options.projectConfigPath,` |
| `src/gateway/supervisor.ts` | 1037 | `projectConfigPath` | delete | `projectConfigPath: options.projectConfigPath,` |
| `src/onboarding/review/apply-executor.ts` | 47 | `projectConfigPath` | delete | `readonly projectConfigPath?: string;` |
| `src/onboarding/review/apply-executor.ts` | 59 | `projectConfigPath` | delete | `readonly projectConfigPath?: string;` |
| `src/onboarding/review/apply-executor.ts` | 155 | `projectConfigPath` | delete | `projectConfigPath: options.projectConfigPath,` |
| `src/onboarding/review/apply-executor.ts` | 155 | `projectConfigPath` | delete | `projectConfigPath: options.projectConfigPath,` |
| `src/onboarding/review/apply-executor.ts` | 469 | `projectConfigPath` | delete | `const projectConfigPath = options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json");` |
| `src/onboarding/review/apply-executor.ts` | 469 | `projectConfigPath` | delete | `const projectConfigPath = options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json");` |
| `src/onboarding/review/apply-executor.ts` | 470 | `projectConfigPath` | delete | `if (targetPath !== undefined && targetPath === projectConfigPath) {` |
| `src/onboarding/review/apply-executor.ts` | 474 | `projectConfigPath` | delete | `projectConfigPath: targetPath,` |
| `src/onboarding/review/apply-executor.ts` | 482 | `projectConfigPath` | delete | `projectConfigPath: options.projectConfigPath,` |
| `src/onboarding/review/apply-executor.ts` | 482 | `projectConfigPath` | delete | `projectConfigPath: options.projectConfigPath,` |
| `src/onboarding/review/apply-executor.ts` | 547 | `projectConfigPath` | delete | `projectConfigPath: options.projectConfigPath,` |
| `src/onboarding/review/apply-executor.ts` | 547 | `projectConfigPath` | delete | `projectConfigPath: options.projectConfigPath,` |
| `src/onboarding/setup-entry-state.ts` | 65 | `projectConfigPath` | delete | `readonly projectConfigPath?: string;` |
| `src/onboarding/setup-entry-state.ts` | 104 | `projectConfigPath` | delete | `projectConfigPath: options.projectConfigPath,` |
| `src/onboarding/setup-entry-state.ts` | 104 | `projectConfigPath` | delete | `projectConfigPath: options.projectConfigPath,` |
| `src/onboarding/setup-entry-state.ts` | 260 | `projectConfigPath` | delete | `project: options.projectConfigPath ?? join(options.workspaceRoot, ".estacoda", "config.json"),` |
| `src/onboarding/verification.ts` | 20 | `projectConfigPath` | delete | `projectConfigPath?: string;` |
| `src/runtime/create-runtime.ts` | 116 | `projectConfigPath` | delete | `projectConfigPath?: string;` |
| `src/runtime/create-runtime.ts` | 435 | `projectConfigPath` | delete | `projectConfigPath: options.projectConfigPath,` |
| `src/runtime/create-runtime.ts` | 435 | `projectConfigPath` | delete | `projectConfigPath: options.projectConfigPath,` |
| `src/runtime/create-runtime.ts` | 994 | `projectConfigPath` | delete | `projectConfigPath: options.projectConfigPath,` |
| `src/runtime/create-runtime.ts` | 994 | `projectConfigPath` | delete | `projectConfigPath: options.projectConfigPath,` |
| `src/runtime/runtime-fingerprint.test.ts` | 58 | `projectConfigPath` | delete | `projectConfigPath?: string;` |
| `src/runtime/runtime-fingerprint.test.ts` | 59 | `projectConfigPath` | delete | `}>): Required<Omit<Parameters<typeof computeRuntimeFingerprint>[1], "userMemoryRoot" \| "projectMemoryRoot" \| "trustStorePath" \| "userConfigPath" \| "projectConfigPath">> & Partia...` |
| `src/runtime/runtime-fingerprint.test.ts` | 59 | `projectConfigPath` | delete | `}>): Required<Omit<Parameters<typeof computeRuntimeFingerprint>[1], "userMemoryRoot" \| "projectMemoryRoot" \| "trustStorePath" \| "userConfigPath" \| "projectConfigPath">> & Partia...` |
| `src/runtime/runtime-fingerprint.test.ts` | 719 | `projectConfigPath` | delete | `fakeOptions({ projectConfigPath: "/other/project.config.js" })` |
| `src/runtime/runtime-fingerprint.test.ts` | 721 | `projectConfigPath` | delete | `expect(fp2.projectConfigPath).toBe("/other/project.config.js");` |
| `src/runtime/runtime-fingerprint.ts` | 63 | `projectConfigPath` | delete | `projectConfigPath?: string;` |
| `src/runtime/runtime-fingerprint.ts` | 82 | `projectConfigPath` | delete | `projectConfigPath?: string;` |
| `src/runtime/runtime-fingerprint.ts` | 132 | `projectConfigPath` | delete | `projectConfigPath: options.projectConfigPath,` |
| `src/runtime/runtime-fingerprint.ts` | 132 | `projectConfigPath` | delete | `projectConfigPath: options.projectConfigPath,` |
