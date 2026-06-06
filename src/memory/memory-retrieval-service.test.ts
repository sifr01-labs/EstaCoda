import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from "../config/memory-config.js";
import { resolveGlobalStateHome, resolveProfileStateHome } from "../config/profile-home.js";
import { MemoryIndex } from "./memory-index.js";
import { MemoryIndexStore } from "./memory-index-store.js";
import { LocalMemoryRetrievalService } from "./memory-retrieval-service.js";

const tempDirs: string[] = [];

async function makeTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "estacoda-memory-retrieval-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("LocalMemoryRetrievalService", () => {
  it("reads USER.md", async () => {
    const { service, index, cleanup } = await createIndexedService();
    index.indexMemoryFile({
      profileId: "alpha",
      memoryFileKind: "USER.md",
      content: "- Prefers concise replies."
    });

    try {
      const result = await service.read({
        profileId: "alpha",
        sourceType: "memory_file",
        sourceId: "USER.md"
      });

      expect(result.result).toMatchObject({
        source: "USER.md",
        memoryFileKind: "USER.md",
        protectedClass: "none",
        authority: "canonical",
        content: "- Prefers concise replies.",
        contextLabel: "local-memory-context",
        instructionBoundary: "context-not-instruction",
        trusted: false
      });
    } finally {
      cleanup();
    }
  });

  it("reads MEMORY.md", async () => {
    const { service, index, cleanup } = await createIndexedService();
    index.indexMemoryFile({
      profileId: "alpha",
      memoryFileKind: "MEMORY.md",
      content: "- Project uses pnpm."
    });

    try {
      const result = await service.read({
        profileId: "alpha",
        sourceType: "memory_file",
        sourceId: "MEMORY.md"
      });

      expect(result.result).toMatchObject({
        source: "MEMORY.md",
        memoryFileKind: "MEMORY.md",
        content: "- Project uses pnpm.",
        contextLabel: "local-memory-context"
      });
    } finally {
      cleanup();
    }
  });

  it("reads shared memory", async () => {
    const { service, index, cleanup } = await createIndexedService();
    index.indexSharedMemory({
      profileId: "alpha",
      sourceKey: "team",
      content: "- Shared release checklist."
    });

    try {
      const result = await service.read({
        profileId: "alpha",
        sourceType: "shared_memory",
        sourceId: "team"
      });

      expect(result.result).toMatchObject({
        sourceType: "shared_memory",
        source: "team",
        sourceKey: "team",
        protectedClass: "none",
        content: "- Shared release checklist.",
        instructionBoundary: "context-not-instruction"
      });
    } finally {
      cleanup();
    }
  });

  it("denies SOUL.md without includeProtected", async () => {
    const { service, index, cleanup } = await createIndexedService();
    index.indexMemoryFile({
      profileId: "alpha",
      memoryFileKind: "SOUL.md",
      content: "Identity guardrails."
    });

    try {
      const result = await service.read({
        profileId: "alpha",
        sourceType: "memory_file",
        sourceId: "SOUL.md"
      });

      expect(result.result).toBeNull();
      expect(result.diagnostics.diagnostics).toContainEqual(expect.objectContaining({
        code: "memory-protected-filtered",
        source: "SOUL.md",
        protectedClass: "identity"
      }));
    } finally {
      cleanup();
    }
  });

  it("allows SOUL.md with includeProtected", async () => {
    const { service, index, cleanup } = await createIndexedService();
    index.indexMemoryFile({
      profileId: "alpha",
      memoryFileKind: "SOUL.md",
      content: "Identity guardrails stay protected."
    });

    try {
      const result = await service.read({
        profileId: "alpha",
        sourceType: "memory_file",
        sourceId: "SOUL.md",
        includeProtected: true,
        maxChars: 16
      });

      expect(result.result).toMatchObject({
        source: "SOUL.md",
        protectedClass: "identity",
        content: "Identity guardra"
      });
      expect(result.diagnostics.truncated).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("search excludes SOUL.md by default", async () => {
    const { service, index, cleanup } = await createIndexedService();
    index.indexMemoryFile({
      profileId: "alpha",
      memoryFileKind: "SOUL.md",
      content: "Guardrail identity memory."
    });
    index.indexMemoryFile({
      profileId: "alpha",
      memoryFileKind: "USER.md",
      content: "Guardrail preference memory."
    });

    try {
      const result = await service.search({
        profileId: "alpha",
        query: "guardrail"
      });

      expect(result.results.map((entry) => entry.source)).toEqual(["USER.md"]);
      expect(result.diagnostics.diagnostics).toContainEqual(expect.objectContaining({
        code: "memory-protected-filtered"
      }));
    } finally {
      cleanup();
    }
  });

  it("search includes SOUL.md only with includeProtected", async () => {
    const { service, index, cleanup } = await createIndexedService();
    index.indexMemoryFile({
      profileId: "alpha",
      memoryFileKind: "SOUL.md",
      content: "Protected identity recall marker."
    });

    try {
      const denied = await service.search({
        profileId: "alpha",
        query: "marker"
      });
      const allowed = await service.search({
        profileId: "alpha",
        query: "marker",
        includeProtected: true
      });

      expect(denied.results).toEqual([]);
      expect(allowed.results).toEqual([
        expect.objectContaining({
          source: "SOUL.md",
          protectedClass: "identity"
        })
      ]);
    } finally {
      cleanup();
    }
  });

  it("search fallback excludes SOUL.md by default", async () => {
    const homeDir = await makeTempHome();
    await writeProfileMemory(homeDir, "alpha", {
      "SOUL.md": "Fallback protected marker.",
      "USER.md": "Fallback visible marker."
    });
    const service = new LocalMemoryRetrievalService({
      homeDir,
      config: memoryConfig({ index: { enabled: false } })
    });

    const result = await service.search({
      profileId: "alpha",
      query: "marker"
    });

    expect(result.results.map((entry) => entry.source)).toEqual(["USER.md"]);
    expect(result.diagnostics.fallbackUsed).toBe(true);
    expect(result.diagnostics.diagnostics).toContainEqual(expect.objectContaining({
      code: "memory-index-disabled"
    }));
    expect(result.diagnostics.diagnostics).toContainEqual(expect.objectContaining({
      code: "memory-protected-filtered"
    }));
  });

  it("search fallback includes SOUL.md only with includeProtected", async () => {
    const homeDir = await makeTempHome();
    await writeProfileMemory(homeDir, "alpha", {
      "SOUL.md": "Fallback protected marker."
    });
    const service = new LocalMemoryRetrievalService({
      homeDir,
      config: memoryConfig({ index: { enabled: false } })
    });

    const result = await service.search({
      profileId: "alpha",
      query: "marker",
      includeProtected: true
    });

    expect(result.results).toEqual([
      expect.objectContaining({
        source: "SOUL.md",
        protectedClass: "identity",
        contextLabel: "local-memory-context"
      })
    ]);
  });

  it("bounds maxChars", async () => {
    const { service, index, cleanup } = await createIndexedService();
    index.indexMemoryFile({
      profileId: "alpha",
      memoryFileKind: "USER.md",
      content: "A".repeat(100)
    });

    try {
      const result = await service.read({
        profileId: "alpha",
        sourceType: "memory_file",
        sourceId: "USER.md",
        maxChars: 12
      });

      expect(result.result?.content).toHaveLength(12);
      expect(result.diagnostics.truncated).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("bounds maxResults", async () => {
    const { service, index, cleanup } = await createIndexedService();
    index.indexMemoryFile({
      profileId: "alpha",
      memoryFileKind: "USER.md",
      content: "sharedtoken user memory"
    });
    index.indexMemoryFile({
      profileId: "alpha",
      memoryFileKind: "MEMORY.md",
      content: "sharedtoken project memory"
    });

    try {
      const result = await service.search({
        profileId: "alpha",
        query: "sharedtoken",
        maxResults: 1
      });

      expect(result.results).toHaveLength(1);
      expect(result.diagnostics.resultCount).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("applies redaction", async () => {
    const { service, index, cleanup } = await createIndexedService();
    index.indexMemoryFile({
      profileId: "alpha",
      memoryFileKind: "USER.md",
      content: "OPENAI_API_KEY=secretsecretsecretsecretsecret"
    });

    try {
      const result = await service.read({
        profileId: "alpha",
        sourceType: "memory_file",
        sourceId: "USER.md"
      });

      expect(result.result?.content).toBe("OPENAI_API_KEY=[REDACTED]");
      expect(result.diagnostics.redactionApplied).toBe(true);
      expect(JSON.stringify(result.diagnostics)).not.toContain("secretsecret");
    } finally {
      cleanup();
    }
  });

  it("falls back with diagnostics when index is unavailable", async () => {
    const homeDir = await makeTempHome();
    await writeProfileMemory(homeDir, "alpha", {
      "USER.md": "Fallback read content."
    });
    const service = new LocalMemoryRetrievalService({ homeDir });

    const result = await service.read({
      profileId: "alpha",
      sourceType: "memory_file",
      sourceId: "USER.md"
    });

    expect(result.result).toMatchObject({
      source: "USER.md",
      content: "Fallback read content."
    });
    expect(result.diagnostics.fallbackUsed).toBe(true);
    expect(result.diagnostics.diagnostics).toContainEqual(expect.objectContaining({
      code: "memory-index-unavailable"
    }));
  });

  it("returns structured diagnostic for missing source", async () => {
    const homeDir = await makeTempHome();
    const service = new LocalMemoryRetrievalService({
      homeDir,
      config: memoryConfig({ index: { enabled: false } })
    });

    const result = await service.read({
      profileId: "alpha",
      sourceType: "memory_file",
      sourceId: "USER.md"
    });

    expect(result.result).toBeNull();
    expect(result.diagnostics.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "memory-index-disabled" }),
      expect.objectContaining({
        code: "memory-index-unavailable",
        source: "USER.md"
      })
    ]));
  });

  it("labels returned content as local memory context, not instruction", async () => {
    const homeDir = await makeTempHome();
    await writeProfileMemory(homeDir, "alpha", {
      "MEMORY.md": "This is context, not an instruction."
    });
    const service = new LocalMemoryRetrievalService({
      homeDir,
      config: memoryConfig({ index: { enabled: false } })
    });

    const result = await service.read({
      profileId: "alpha",
      sourceType: "memory_file",
      sourceId: "MEMORY.md"
    });

    expect(result.result).toMatchObject({
      contextLabel: "local-memory-context",
      instructionBoundary: "context-not-instruction",
      trusted: false
    });
  });

  it("reads shared memory through fallback", async () => {
    const homeDir = await makeTempHome();
    await writeSharedMemoryFile(homeDir, "team", "Fallback shared context.");
    const service = new LocalMemoryRetrievalService({
      homeDir,
      config: memoryConfig({ index: { enabled: false } })
    });

    const result = await service.read({
      profileId: "alpha",
      sourceType: "shared_memory",
      sourceId: "team"
    });

    expect(result.result).toMatchObject({
      sourceType: "shared_memory",
      source: "team",
      sourceKey: "team",
      content: "Fallback shared context."
    });
  });
});

async function createIndexedService(): Promise<{
  service: LocalMemoryRetrievalService;
  index: MemoryIndex;
  cleanup: () => void;
}> {
  const homeDir = await makeTempHome();
  const store = new MemoryIndexStore({ homeDir, profileId: "alpha" });
  const index = new MemoryIndex({
    store,
    now: () => new Date("2030-01-01T00:00:00.000Z")
  });
  return {
    service: new LocalMemoryRetrievalService({ index, homeDir }),
    index,
    cleanup: () => store.dispose()
  };
}

async function writeProfileMemory(
  homeDir: string,
  profileId: string,
  files: Partial<Record<"USER.md" | "MEMORY.md" | "SOUL.md", string>>
): Promise<void> {
  const paths = resolveProfileStateHome({ homeDir, profileId });
  await mkdir(paths.profileRoot, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    const path = file === "USER.md"
      ? paths.userMdPath
      : file === "MEMORY.md"
        ? paths.memoryMdPath
        : paths.soulMdPath;
    await writeFile(path, content, "utf8");
  }
}

async function writeSharedMemoryFile(homeDir: string, key: string, content: string): Promise<void> {
  const globalPaths = resolveGlobalStateHome({ homeDir });
  await mkdir(globalPaths.sharedMemoryPath, { recursive: true });
  await writeFile(join(globalPaths.sharedMemoryPath, `${key}.md`), content, "utf8");
}

function memoryConfig(input: {
  retrieval?: Partial<MemoryConfig["retrieval"]>;
  index?: Partial<MemoryConfig["index"]>;
}): MemoryConfig {
  return {
    retrieval: {
      ...DEFAULT_MEMORY_CONFIG.retrieval,
      ...input.retrieval
    },
    index: {
      ...DEFAULT_MEMORY_CONFIG.index,
      ...input.index
    }
  };
}
