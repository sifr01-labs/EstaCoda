import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionArtifactRegistration } from "../contracts/artifact.js";
import { ArtifactStore } from "./artifact-store.js";

const roots: string[] = [];
const content = '{"openapi":"3.1.0","paths":{}}';
const sha256 = createHash("sha256").update(content).digest("hex");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ArtifactStore durable session artifacts", () => {
  it("hydrates only an intact artifact owned by the current session and profile", async () => {
    const root = await temporaryRoot();
    const capture = join(root, "capture.json");
    await writeFile(capture, content);
    let registration: SessionArtifactRegistration | undefined;
    const first = store(root);
    const retained = await first.retainSessionArtifact({
      ...scope(),
      capturePath: capture,
      kind: "data",
      bytes: Buffer.byteLength(content),
      mimeType: "application/json",
      sha256,
      source: source(),
      persist: async (value) => { registration = value; }
    });

    expect(registration).toMatchObject({
      id: "artifact-1",
      storageKey: "objects/object-1",
      sessionId: "session-1",
      profileId: "profile-1"
    });
    expect(JSON.stringify(registration)).not.toContain(root);
    expect(registration?.storageKey).not.toContain("openapi.json");
    expect(first.get(retained.id, scope())).toBeDefined();
    expect(first.get(retained.id, { ...scope(), sessionId: "session-2" })).toBeUndefined();
    expect(first.get(retained.id, { ...scope(), profileId: "profile-2" })).toBeUndefined();
    expect(first.get(retained.id)).toBeUndefined();

    const recreated = store(root);
    await expect(recreated.hydrateSessionArtifacts({
      events: [{ kind: "session-artifact-registered", artifact: registration }],
      ...scope()
    })).resolves.toHaveLength(1);
    expect(recreated.get("artifact://artifact-1", scope())).toMatchObject({
      path: "artifact://artifact-1",
      mimeType: "application/json",
      metadata: { sha256, source: "browser.download" }
    });

    await recreated.hydrateSessionArtifacts({
      events: [{
        kind: "session-artifact-registered",
        artifact: { ...registration!, sessionId: "session-compacted" }
      }],
      sessionId: "session-compacted",
      profileId: "profile-1"
    });
    expect(recreated.get("artifact://artifact-1", {
      sessionId: "session-compacted",
      profileId: "profile-1"
    })).toBeDefined();
    expect(recreated.get("artifact://artifact-1", {
      sessionId: "unrelated-session",
      profileId: "profile-1"
    })).toBeUndefined();
  });

  it("rejects path escapes, missing files, MIME changes, hash changes, and legacy events", async () => {
    const root = await temporaryRoot();
    const valid = await retainedRegistration(root);
    const cases: unknown[] = [
      { ...valid, storageKey: "../escape" },
      { ...valid, storageKey: "objects/missing" },
      { ...valid, mimeType: "application/yaml" },
      { ...valid, sha256: "0".repeat(64) }
    ];
    for (const artifact of cases) {
      const candidate = store(root);
      await expect(candidate.hydrateSessionArtifacts({
        events: [{ kind: "session-artifact-registered", artifact }],
        ...scope()
      })).resolves.toEqual([]);
      expect(candidate.list(scope())).toEqual([]);
    }

    const legacy = store(root);
    await expect(legacy.hydrateSessionArtifacts({
      events: [{
        kind: "artifact-created",
        artifact: { id: valid.id, path: `artifact://${valid.id}`, kind: "data", bytes: valid.bytes, createdAt: valid.createdAt }
      }],
      ...scope()
    })).resolves.toEqual([]);
  });

  it("leaves only an unreferenced orphan if persistence fails after the file move", async () => {
    const root = await temporaryRoot();
    const capture = join(root, "capture.json");
    await writeFile(capture, content);
    const target = store(root);

    await expect(target.retainSessionArtifact({
      ...scope(),
      capturePath: capture,
      kind: "data",
      bytes: Buffer.byteLength(content),
      mimeType: "application/json",
      sha256,
      source: source(),
      persist: async () => { throw new Error("event write failed"); }
    })).rejects.toThrow("event write failed");

    expect(target.list(scope())).toEqual([]);
    expect(await readdir(join(root, "artifacts", "objects"))).toEqual(["object-1"]);
  });
});

async function retainedRegistration(root: string): Promise<SessionArtifactRegistration> {
  const capture = join(root, "capture.json");
  await writeFile(capture, content);
  let registration: SessionArtifactRegistration | undefined;
  await store(root).retainSessionArtifact({
    ...scope(),
    capturePath: capture,
    kind: "data",
    bytes: Buffer.byteLength(content),
    mimeType: "application/json",
    sha256,
    source: source(),
    persist: async (value) => { registration = value; }
  });
  return registration!;
}

function store(root: string): ArtifactStore {
  return new ArtifactStore({
    storageRoot: join(root, "artifacts"),
    id: () => "artifact-1",
    storageId: () => "object-1"
  });
}

function scope() {
  return { sessionId: "session-1", profileId: "profile-1" };
}

function source() {
  return {
    kind: "browser.download" as const,
    description: "Governed browser download.",
    filename: "openapi.json",
    origin: "https://developer.example.test"
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "estacoda-artifact-store-"));
  roots.push(root);
  return root;
}
