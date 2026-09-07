import { mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../artifacts/artifact-store.js";
import { createMockBrowserBackend } from "../browser/browser-backend.js";
import { BrowserTargetError } from "../browser/browser-locator.js";
import type { BrowserBackend, BrowserDownloadInput } from "../contracts/browser.js";
import type { SessionArtifactRegistration } from "../contracts/artifact.js";
import { ExecutionCheckpointController } from "../runtime/execution-checkpoint-controller.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { createWebTools, webToolProvider } from "./web-tools.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("browser.download", () => {
  it("omits credential-bearing source-page locators while retaining the safe download receipt", async () => {
    const root = await temporaryRoot();
    const backend = downloadBackend(async (input) => {
      const localPath = join(input.destinationDirectory, "safe-description");
      await writeFile(localPath, '{"openapi":"3.1.0","paths":{}}', { mode: 0o600 });
      return { outcome: "download-completed", localPath, suggestedFilename: "description.json",
        sourceUrl: "https://developer.example.test/export", pageUrl: "https://developer.example.test/callback?code=private-value" };
    });
    const result = await browserDownloadTool(backend, root, new ArtifactStore()).run(groundedInput());
    expect(result.ok).toBe(true);
    expect(result.metadata).not.toHaveProperty("pageUrl");
    expect(JSON.stringify(result)).not.toContain("private-value");
  });
  it("captures a grounded Swagger artifact into constrained storage with a metadata-only receipt", async () => {
    const root = await temporaryRoot();
    const artifactStore = new ArtifactStore({
      id: () => "artifact-1",
      storageId: () => "object-1",
      storageRoot: join(root, "durable-artifacts")
    });
    const registrations: SessionArtifactRegistration[] = [];
    const captured: BrowserDownloadInput[] = [];
    const backend = downloadBackend(async (input) => {
      captured.push(input);
      const localPath = join(input.destinationDirectory, "download-guid");
      await writeFile(localPath, JSON.stringify({ openapi: "3.1.0", paths: {} }), { mode: 0o600 });
      return {
        outcome: "download-completed",
        localPath,
        suggestedFilename: "../../openapi.json",
        sourceUrl: "https://developer.example.test/session/export",
        pageUrl: "https://developer.example.test/products/original#/v2",
        sizeBytes: (await stat(localPath)).size
      };
    });
    const download = browserDownloadTool(backend, root, artifactStore, async (artifact) => {
      registrations.push(artifact);
    });

    const result = await download.run(groundedInput());

    expect(result.ok).toBe(true);
    expect(result.metadata).toEqual({
      pageUrl: "https://developer.example.test/products/original#/v2",
      artifactId: "artifact-1",
      filename: "openapi.json",
      mimeType: "application/json",
      sizeBytes: 30,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      sourceOrigin: "https://developer.example.test",
      apiDescription: { format: "OpenAPI", version: "3.1.0" },
      outcome: "download-completed",
      artifact: {
        id: "artifact-1",
        path: "artifact://artifact-1",
        kind: "data",
        bytes: 30,
        createdAt: expect.any(String),
        summary: "Governed browser download captured from a current grounded page target.",
        mimeType: "application/json",
        metadata: {
          apiDescription: { format: "OpenAPI", version: "3.1.0" },
          filename: "openapi.json",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          sourceOrigin: "https://developer.example.test",
          source: "browser.download",
          outcome: "download-completed"
        }
      }
    });
    expect(result.metadata?.artifact).not.toHaveProperty("localPath");
    expect(result.content).not.toContain(root);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ sessionId: "browser-session", ref: "@e1", tabRef: "@t1" });
    expect(captured[0]?.destinationDirectory).toContain(root);
    expect(captured[0]?.maxBytes).toBe(25 * 1024 * 1024);
    const [artifact] = artifactStore.list({ sessionId: "runtime-session", profileId: "profile-1" });
    expect(artifact?.path).toBe("artifact://artifact-1");
    expect(artifact?.metadata).toMatchObject({ source: "browser.download", outcome: "download-completed" });
    expect(await readFile(artifact!.localPath!, "utf8")).toContain('"openapi":"3.1.0"');
    expect((await stat(artifact!.localPath!)).mode & 0o777).toBe(0o600);
    expect(artifact?.localPath).toBe(
      await realpath(join(root, "durable-artifacts", "objects", "object-1"))
    );
    expect(registrations).toEqual([expect.objectContaining({
      id: "artifact-1",
      sessionId: "runtime-session",
      profileId: "profile-1",
      storageKey: "objects/object-1"
    })]);
    expect(JSON.stringify(registrations)).not.toContain(root);
  });

  it("attaches a durable download before returning control to the provider loop", async () => {
    const root = await temporaryRoot();
    const db = new SQLiteSessionDB({ path: join(root, "sessions.sqlite") });
    try {
      await db.createSession({ id: "runtime-session", profileId: "profile-1" });
      const checkpoint = new ExecutionCheckpointController({
        sessionId: "runtime-session",
        profileId: "profile-1",
        createId: () => "checkpoint-1",
        now: () => "2030-01-01T00:00:00.000Z",
        record: (event) => db.appendEvent("runtime-session", event)
      });
      await checkpoint.ensure({
        originTurnId: "turn-1",
        originalObjective: "Import the downloaded API description.",
        qualificationReasons: ["cross_system"],
        selectedSkillName: "api-integration",
        taskClass: "browser-operation",
        intentLabels: ["api-integration"],
        requiredOperations: ["artifact_relay"],
        connectorIds: ["postman"],
        completionFloor: "mutation_with_verification"
      });
      const backend = downloadBackend(async (input) => {
        const localPath = join(input.destinationDirectory, "openapi.json");
        await writeFile(localPath, JSON.stringify({ openapi: "3.1.0", paths: {} }), { mode: 0o600 });
        return {
          outcome: "download-completed",
          localPath,
          suggestedFilename: "openapi.json",
          sourceUrl: "https://93.184.216.34/export",
          sizeBytes: (await stat(localPath)).size
        };
      });
      const artifactStore = new ArtifactStore({
        storageRoot: join(root, "artifacts"),
        id: () => "artifact-before-continuation",
        storageId: () => "object-before-continuation"
      });
      const download = webToolProvider.createTools({
        workspaceRoot: root,
        homeDir: root,
        profileId: "profile-1",
        sessionId: "runtime-session",
        currentSessionId: () => "runtime-session",
        channelMediaRoot: join(root, "channel-media"),
        browserBackend: backend,
        artifactStore,
        sessionDb: db,
        executionCheckpointController: checkpoint
      }).find((candidate) => candidate.name === "browser.download");
      if (download === undefined) throw new Error("browser.download was not registered");

      await expect(download.run(groundedInput())).resolves.toMatchObject({ ok: true });

      expect(checkpoint.current()?.artifactReferences).toEqual([{
        id: "artifact-before-continuation",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
      }]);
      const events = await db.listEvents("runtime-session");
      const registrationIndex = events.findIndex((event) => event.kind === "session-artifact-registered");
      const attachmentIndex = events.findIndex((event) =>
        event.kind === "execution-checkpoint-updated" && event.transition === "artifact_attached"
      );
      expect(registrationIndex).toBeGreaterThanOrEqual(0);
      expect(attachmentIndex).toBeGreaterThan(registrationIndex);
    } finally {
      db.close();
    }
  });

  it("propagates runtime cancellation to the browser backend", async () => {
    const root = await temporaryRoot();
    const controller = new AbortController();
    const captured: BrowserDownloadInput[] = [];
    const backend = downloadBackend(async (input) => {
      captured.push(input);
      return { outcome: "download-failed", reason: "cancelled" };
    });

    await browserDownloadTool(backend, root, new ArtifactStore()).run(
      groundedInput(),
      { signal: controller.signal }
    );

    expect(captured[0]?.signal).toBe(controller.signal);
  });

  it("tells the agent not to repeat the page click when a native save dialog is suspected", async () => {
    const root = await temporaryRoot();
    const backend = downloadBackend(async () => ({
      outcome: "download-failed",
      reason: "native-save-dialog-suspected"
    }));

    const result = await browserDownloadTool(backend, root, new ArtifactStore()).run(groundedInput());

    expect(result).toMatchObject({
      ok: false,
      metadata: {
        outcome: "download-failed",
        reason: "native-save-dialog-suspected"
      }
    });
    expect(result.content).toContain("do not click the page download control again");
    expect(result.content).toContain("runtime must suppress the native prompt");
  });

  it("retains YAML Swagger content and records its authoritative hash", async () => {
    const root = await temporaryRoot();
    const artifactStore = new ArtifactStore({ id: () => "artifact-yaml" });
    const yaml = "openapi: 3.1.0\npaths: {}\n";
    const backend = downloadBackend(async (input) => {
      const localPath = join(input.destinationDirectory, "download-guid");
      await writeFile(localPath, yaml, { mode: 0o600 });
      return {
        outcome: "download-completed",
        localPath,
        suggestedFilename: "openapi.yaml",
        sourceUrl: "https://developer.example.test/openapi.yaml",
        sizeBytes: Buffer.byteLength(yaml)
      };
    });

    const result = await browserDownloadTool(backend, root, artifactStore).run(groundedInput());

    expect(result).toMatchObject({
      ok: true,
      metadata: {
        artifactId: "artifact-yaml",
        filename: "openapi.yaml",
        mimeType: "application/yaml",
        sizeBytes: Buffer.byteLength(yaml),
        sha256: "591376d036294574c649b1eef67413f22425b7d3692c95242c5ab4699b6fef8a",
        apiDescription: { format: "OpenAPI", version: "3.1.0" },
        outcome: "download-completed"
      }
    });
    const [artifact] = artifactStore.list();
    expect(await readFile(artifact!.localPath!, "utf8")).toBe(yaml);
  });

  it("accepts a safe textual GraphQL schema as a machine-readable API artifact", async () => {
    const root = await temporaryRoot();
    const schema = "type Query { health: String! }\n";
    const backend = downloadBackend(async (input) => {
      const localPath = join(input.destinationDirectory, "download-guid");
      await writeFile(localPath, schema, { mode: 0o600 });
      return {
        outcome: "download-completed",
        localPath,
        suggestedFilename: "schema.graphql",
        sourceUrl: "https://developer.example.test/schema.graphql",
        sizeBytes: Buffer.byteLength(schema)
      };
    });

    const result = await browserDownloadTool(backend, root, new ArtifactStore()).run(groundedInput());

    expect(result).toMatchObject({
      ok: true,
      metadata: {
        mimeType: "application/graphql",
        apiDescription: { format: "GraphQL" },
        outcome: "download-completed"
      }
    });
  });

  it("blocks executable content and removes partial capture files", async () => {
    const root = await temporaryRoot();
    const artifactStore = new ArtifactStore();
    const backend = downloadBackend(async (input) => {
      const localPath = join(input.destinationDirectory, "payload");
      await writeFile(localPath, Buffer.from([0x4d, 0x5a, 0x90, 0x00]));
      return {
        outcome: "download-completed",
        localPath,
        suggestedFilename: "openapi.json",
        sourceUrl: "https://developer.example.test/export",
        sizeBytes: 4
      };
    });

    const result = await browserDownloadTool(backend, root, artifactStore).run(groundedInput());

    expect(result).toMatchObject({ ok: false, metadata: { outcome: "download-type-blocked", reason: "executable-or-script-content" } });
    expect(artifactStore.list()).toEqual([]);
  });

  it("blocks private redirects and never exposes secret query data", async () => {
    const root = await temporaryRoot();
    const secret = "secret-secret-secret";
    const backend = downloadBackend(async (input) => {
      const localPath = join(input.destinationDirectory, "payload");
      await writeFile(localPath, "safe text");
      return {
        outcome: "download-completed",
        localPath,
        suggestedFilename: "notes.txt",
        sourceUrl: `http://169.254.169.254/latest?token=${secret}`,
        sizeBytes: 9
      };
    });

    const result = await browserDownloadTool(backend, root, new ArtifactStore()).run(groundedInput());

    expect(result).toMatchObject({ ok: false, metadata: { outcome: "download-blocked", reason: "unsafe-download-redirect" } });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("keeps unsupported download functionality unavailable", async () => {
    const root = await temporaryRoot();
    const tool = browserDownloadTool(createMockBrowserBackend(), root, new ArtifactStore());
    await expect(tool.isAvailable()).resolves.toBe(false);
  });

  it("fails closed with current context when the grounded ref is stale", async () => {
    const root = await temporaryRoot();
    const backend = downloadBackend(async () => {
      throw new BrowserTargetError({
        reason: "stale-browser-ref",
        message: "stale target",
        currentSessionId: "browser-session:main",
        currentIdentity: { documentEpoch: 2, actionRevision: 3, observationId: 4 },
        currentTabRef: "@t2",
        nearbyCandidates: [{
          ref: "@e9",
          identity: { documentEpoch: 2, actionRevision: 3, observationId: 4 },
          tabRef: "@t2",
          role: "link",
          name: "Download OpenAPI"
        }]
      });
    });

    const result = await browserDownloadTool(backend, root, new ArtifactStore()).run(groundedInput());

    expect(result).toMatchObject({
      ok: false,
      metadata: {
        outcome: "download-blocked",
        reason: "stale-browser-ref",
        currentTabRef: "@t2",
        nearbyCandidates: [{ ref: "@e9", name: "Download OpenAPI" }]
      }
    });
  });
});

function downloadBackend(
  download: NonNullable<BrowserBackend["download"]>
): BrowserBackend {
  const base = createMockBrowserBackend();
  return {
    ...base,
    capabilities: { ...base.capabilities, downloads: true, nativePointer: true, controlledNewTabs: true },
    download
  };
}

function browserDownloadTool(
  backend: BrowserBackend,
  root: string,
  artifactStore: ArtifactStore,
  persistSessionArtifact?: (artifact: SessionArtifactRegistration) => Promise<void>
) {
  const tool = createWebTools({
    browserBackend: backend,
    browserDownloadRoot: root,
    artifactStore,
    currentSessionId: () => persistSessionArtifact === undefined ? "browser-session" : "runtime-session",
    ...(persistSessionArtifact === undefined ? {} : {
      profileId: "profile-1",
      persistSessionArtifact: async (_sessionId: string, artifact: SessionArtifactRegistration) => persistSessionArtifact(artifact)
    }),
    resolveHostname: async () => ["93.184.216.34"]
  }).find((candidate) => candidate.name === "browser.download");
  if (tool === undefined) throw new Error("browser.download was not registered");
  return tool;
}

function groundedInput() {
  return {
    sessionId: "browser-session",
    ref: "@e1",
    identity: { documentEpoch: 1, actionRevision: 1, observationId: 1 },
    tabRef: "@t1"
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "estacoda-browser-download-"));
  roots.push(root);
  return root;
}
