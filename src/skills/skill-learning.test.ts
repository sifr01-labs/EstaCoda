import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionDB } from "../contracts/session.js";
import type { ToolDefinition } from "../contracts/tool.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { SkillLearningManager } from "./skill-learning.js";
import { SkillRegistry } from "./skill-registry.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "estacoda-skill-learning-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("SkillLearningManager", () => {
  it("strips hidden reasoning from learned workflow content", async () => {
    const root = await makeTempDir();
    const manager = new SkillLearningManager({
      autonomy: "proactive",
      registry: new SkillRegistry(),
      localSkillsRoot: join(root, "skills"),
      storePath: join(root, "skill-learning.json"),
      sessionDb: fakeSessionDb()
    });

    await manager.observeTurn({
      profileId: "profile",
      sessionId: "session",
      userText: "<think>private chain</think>Run the release checks",
      selectedSkill: undefined,
      toolExecutions: [execution("shell"), execution("file.read")]
    });

    const records = await manager.inspect();
    expect(records[0]?.content).toContain("Run the release checks");
    expect(records[0]?.content).not.toContain("private chain");
    expect(records[0]?.content).not.toContain("<think>");
  });
});

function execution(name: string): ToolExecutionRecord {
  return {
    tool: {
      name,
      description: name,
      inputSchema: {},
      riskClass: "workspace-write",
      toolsets: ["shell-write"],
      progressLabel: name,
      maxResultSizeChars: 1_000
    } satisfies ToolDefinition,
    decision: "allow",
    riskClass: "workspace-write",
    result: {
      ok: true,
      content: "ok"
    }
  };
}

function fakeSessionDb(): SessionDB {
  return {
    appendEvent: async () => undefined
  } as unknown as SessionDB;
}
