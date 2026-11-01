import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
import { SkillEvolutionStore } from "../skills/skill-evolution.js";
import { createRuntime } from "./create-runtime.js";
import { resolveTokens } from "../theme/token-resolver.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";

it("refreshes changed/removed skills between turns and reapplies visibility without revealing hidden names", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-refresh-"));
  const skills = join(root, "skills");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const write = async (name: string, body: string, extra = {}) => {
    await mkdir(join(skills, name), { recursive: true });
    await writeFile(join(skills, name, "SKILL.md"), `---\n${JSON.stringify({ name, description: body, requiredToolsets: ["files"], ...extra })}\n---\n${body}\n`);
  };
  await write("refresh-example", "Old instructions");
  const trust = new WorkspaceTrustStore({ path: join(root, "trust.json") });
  await trust.grant(workspace);
  const db = new InMemorySessionDB();
  const runtime = await createRuntime({ homeDir: join(root, "home"), workspaceRoot: workspace, localSkillsRoot: skills,
    sessionDb: db, trustStore: trust, skillAutonomy: "none", tokens: resolveTokens("standard", "dark", "kemetBlue"),
    model: { provider: "unconfigured", id: "unconfigured", contextWindowTokens: 8_000, supportsTools: false, supportsVision: false, supportsStructuredOutput: false } });
  try {
    await write("refresh-example", "New instructions");
    await write("hidden-profile-skill", "Hidden instructions", { platforms: ["impossible-platform"] });
    await runtime.handle({ text: "Hello", channel: "cli", trustedWorkspace: true });
    expect(runtime.resolveSkill?.("refresh-example")).toMatchObject({ instructions: expect.stringContaining("New instructions") });
    expect(runtime.skills().map(skill => skill.name)).not.toContain("hidden-profile-skill");
    const messages = await db.listMessages(runtime.sessionId);
    const notices = messages.filter(message => message.metadata?.kind === "skill-catalog-refreshed");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.content).toContain('"changed":["refresh-example"]');
    expect(notices[0]?.content).not.toContain("hidden-profile-skill");
    const store = new SkillEvolutionStore({ usagePath: join(skills, ".usage.json"), evolutionRoot: join(skills, ".evolution") });
    await store.archiveSkill("refresh-example", "local");
    await runtime.handle({ text: "Hello again", channel: "cli", trustedWorkspace: true });
    expect(runtime.skills().map(skill => skill.name)).not.toContain("refresh-example");
    await writeFile(join(skills, "refresh-example", "SKILL.md"), "invalid definition");
    await runtime.handle({ text: "Hello again", channel: "cli", trustedWorkspace: true });
    expect(runtime.skills().map(skill => skill.name)).not.toContain("refresh-example");
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
});
