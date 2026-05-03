import type { ArtifactStore } from "../artifacts/artifact-store.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { InMemorySessionDB } from "../session/in-memory-session-db.js";
import type { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import type { SkillRegistry } from "../skills/skill-registry.js";
import type { SkillEvolutionStore } from "../skills/skill-evolution.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";

export type SmokeContext = {
  tools: ToolRegistry;
  skills: SkillRegistry;
  memory: MemoryStore;
  artifacts: ArtifactStore;
  sessionDb: InMemorySessionDB;
  sqliteDb: SQLiteSessionDB;
  trajectory: TrajectoryRecorder;
  personalSkillRoot: string;
  skillEvolutionStore: SkillEvolutionStore;
  configToolsWorkspace: string;
  configToolsHome: string;
};

export type SmokeCase = {
  id: string;
  name: string;
  tags: string[];
  run: (context: SmokeContext) => Promise<void>;
};
