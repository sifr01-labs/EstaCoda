import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactStore } from "../../artifacts/artifact-store.js";
import { MemoryStore } from "../../memory/memory-store.js";
import { InMemorySessionDB } from "../../session/in-memory-session-db.js";
import { SQLiteSessionDB } from "../../session/sqlite-session-db.js";
import { SkillRegistry } from "../../skills/skill-registry.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import { TrajectoryRecorder } from "../../trajectory/trajectory-recorder.js";
import { loadSkillsFromDirectory } from "../../skills/skill-loader.js";
import { builtinTools } from "../../tools/builtin-tools.js";
import { createConfigTools } from "../../config/config-tools.js";
import { createMemoryTool } from "../../memory/memory-tool.js";
import { createProcessTools } from "../../process/process-tools.js";
import { createPythonTools } from "../../tools/python-tools.js";
import { createWebTools } from "../../tools/web-tools.js";
import { createWorkspaceTools } from "../../tools/workspace-tools.js";
import { createMediaTools } from "../../tools/media-tools.js";
import { createSkillTools } from "../../skills/skill-tools.js";
import { createWorkspaceTrustTools } from "../../security/workspace-trust-tools.js";
import { WorkspaceTrustStore } from "../../security/workspace-trust-store.js";
import { ProcessManager } from "../../process/process-manager.js";
import { SkillEvolutionStore } from "../../skills/skill-evolution.js";

let _seq = 0;
export function sequenceId(): () => string {
  const prefix = `smoke-${++_seq}`;
  let id = 0;
  return () => `${prefix}-${++id}`;
}

export function smokeNow(): () => Date {
  return () => new Date("2026-04-16T00:00:00.000Z");
}

export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function createFreshToolRegistry(): Promise<ToolRegistry> {
  return new ToolRegistry();
}

export async function createFreshSkillRegistry(): Promise<SkillRegistry> {
  const skills = new SkillRegistry();
  const loaded = await loadSkillsFromDirectory(
    new URL("../../skills/official", import.meta.url).pathname
  );
  for (const skill of loaded.skills) {
    skills.register(skill);
  }
  return skills;
}

export async function createFreshMemoryStore(): Promise<MemoryStore> {
  return new MemoryStore();
}

export async function createFreshArtifactStore(): Promise<ArtifactStore> {
  return new ArtifactStore({
    id: sequenceId(),
    now: smokeNow()
  });
}

export async function createFreshSessionDb(): Promise<InMemorySessionDB> {
  return new InMemorySessionDB({
    id: sequenceId(),
    now: smokeNow()
  });
}

export async function createFreshSqliteDb(): Promise<SQLiteSessionDB> {
  const path = join(await makeTempDir("estacoda-sessions-"), "sessions.sqlite");
  return new SQLiteSessionDB({
    path,
    id: sequenceId(),
    now: smokeNow()
  });
}

export async function createFreshTrajectory(): Promise<TrajectoryRecorder> {
  return new TrajectoryRecorder({
    profileId: "smoke",
    sessionId: "smoke",
    modelId: "smoke-model",
    id: sequenceId(),
    now: smokeNow()
  });
}

export async function registerBuiltinTools(tools: ToolRegistry): Promise<void> {
  for (const tool of builtinTools) {
    tools.register(tool);
  }
}

export async function registerStandardTools(tools: ToolRegistry, options: {
  workspaceRoot?: string;
  artifactStore?: ArtifactStore;
  skills?: SkillRegistry;
  personalSkillRoot?: string;
  skillEvolutionStore?: SkillEvolutionStore;
  configWorkspace?: string;
  configHome?: string;
} = {}): Promise<void> {
  const ws = options.workspaceRoot ?? process.cwd();
  const artifacts = options.artifactStore;

  for (const tool of createPythonTools({ workspaceRoot: ws })) {
    tools.register(tool);
  }
  for (const tool of createWebTools()) {
    tools.register(tool);
  }
  for (const tool of createWorkspaceTools({ workspaceRoot: ws })) {
    tools.register(tool);
  }
  if (artifacts) {
    for (const tool of createMediaTools({ workspaceRoot: ws, artifactStore: artifacts })) {
      tools.register(tool);
    }
  }
  for (const tool of createProcessTools({
    processManager: new ProcessManager({
      workspaceRoot: ws,
      id: sequenceId(),
      now: smokeNow()
    })
  })) {
    tools.register(tool);
  }
  for (const tool of createWorkspaceTrustTools({
    workspaceRoot: ws,
    trustStore: new WorkspaceTrustStore({
      path: join(await makeTempDir("estacoda-global-trust-"), "trust.json")
    })
  })) {
    tools.register(tool);
  }

  if (options.configWorkspace && options.configHome) {
    for (const tool of createConfigTools({
      workspaceRoot: options.configWorkspace,
      homeDir: options.configHome
    })) {
      tools.register(tool);
    }
  }

  if (options.skills && options.personalSkillRoot && options.skillEvolutionStore) {
    for (const tool of createSkillTools({
      registry: options.skills,
      localSkillsRoot: options.personalSkillRoot,
      skillEvolutionStore: options.skillEvolutionStore
    })) {
      tools.register(tool);
    }
  }
}

export async function createFreshSkillEvolutionStore(): Promise<SkillEvolutionStore> {
  const root = await makeTempDir("estacoda-skill-evolution-");
  return new SkillEvolutionStore({
    usagePath: join(root, "skill-usage.json"),
    evolutionRoot: join(root, "skill-evolution")
  });
}

import type { SmokeContext } from "../smoke-case.js";
import { renderMemorySnapshot } from "../../memory/memory-renderer.js";
import { LocalMemoryProvider } from "../../memory/local-memory-provider.js";

export async function createSmokeContext(): Promise<SmokeContext> {
  const tools = new ToolRegistry();
  const skills = new SkillRegistry();
  const memory = new MemoryStore();
  const artifacts = new ArtifactStore({
    id: sequenceId(),
    now: smokeNow()
  });
  const sessionDb = new InMemorySessionDB({
    id: sequenceId(),
    now: smokeNow()
  });
  const sqlitePath = join(await makeTempDir("estacoda-sessions-"), "sessions.sqlite");
  const sqliteDb = new SQLiteSessionDB({
    path: sqlitePath,
    id: sequenceId(),
    now: smokeNow()
  });
  const trajectory = new TrajectoryRecorder({
    profileId: "smoke",
    sessionId: "smoke",
    modelId: "smoke-model",
    id: sequenceId(),
    now: smokeNow()
  });

  const loadedSkills = await loadSkillsFromDirectory(
    new URL("../../skills/official", import.meta.url).pathname
  );
  for (const skill of loadedSkills.skills) {
    skills.register(skill);
  }

  const personalSkillRoot = join(await makeTempDir("estacoda-personal-skills-"), "skills");
  const skillEvolutionStore = await createFreshSkillEvolutionStore();

  const configToolsWorkspace = await makeTempDir("estacoda-config-tools-workspace-");
  const configToolsHome = await makeTempDir("estacoda-config-tools-home-");

  for (const tool of builtinTools) {
    tools.register(tool);
  }
  for (const tool of createSkillTools({
    registry: skills,
    localSkillsRoot: personalSkillRoot,
    skillEvolutionStore
  })) {
    tools.register(tool);
  }
  for (const tool of createPythonTools({ workspaceRoot: process.cwd() })) {
    tools.register(tool);
  }
  for (const tool of createWebTools()) {
    tools.register(tool);
  }
  for (const tool of createWorkspaceTools({ workspaceRoot: process.cwd() })) {
    tools.register(tool);
  }
  for (const tool of createMediaTools({ workspaceRoot: process.cwd(), artifactStore: artifacts })) {
    tools.register(tool);
  }
  for (const tool of createProcessTools({
    processManager: new ProcessManager({
      workspaceRoot: process.cwd(),
      id: sequenceId(),
      now: smokeNow()
    })
  })) {
    tools.register(tool);
  }
  for (const tool of createWorkspaceTrustTools({
    workspaceRoot: process.cwd(),
    trustStore: new WorkspaceTrustStore({
      path: join(await makeTempDir("estacoda-global-trust-"), "trust.json")
    })
  })) {
    tools.register(tool);
  }
  for (const tool of createConfigTools({
    workspaceRoot: configToolsWorkspace,
    homeDir: configToolsHome
  })) {
    tools.register(tool);
  }
  tools.register(createMemoryTool(memory));

  memory.apply({
    kind: "append",
    file: "MEMORY.md",
    content: "EstaCoda v2 should learn reusable workflows."
  });
  memory.apply({
    kind: "replace",
    file: "MEMORY.md",
    match: "learn reusable workflows",
    replacement: "learn reusable workflows and promote repeated patterns into skills"
  });
  trajectory.record("user-input", {
    text: "Build a knowledge base from this YouTube URL."
  });

  const localMemoryProvider = new LocalMemoryProvider({ store: memory });
  await localMemoryProvider.conclude({
    id: "smoke-pref",
    kind: "user-preference",
    content: "Prefer concise replies.",
    confidence: 0.8
  });

  return {
    tools,
    skills,
    memory,
    artifacts,
    sessionDb,
    sqliteDb,
    trajectory,
    personalSkillRoot,
    skillEvolutionStore,
    configToolsWorkspace,
    configToolsHome
  };
}
