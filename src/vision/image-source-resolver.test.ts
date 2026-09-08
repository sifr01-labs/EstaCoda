import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveVisionImageSource } from "./image-source-resolver.js";

const VALID_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
);

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

async function createWorkspace(): Promise<{ root: string; workspace: string }> {
  const root = await mkdtemp(join(tmpdir(), "estacoda-vision-source-"));
  temporaryRoots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  return { root, workspace };
}

describe("resolveVisionImageSource", () => {
  it("reads a regular image and returns a relative display path", async () => {
    const { workspace } = await createWorkspace();
    await mkdir(join(workspace, "images"));
    await writeFile(join(workspace, "images", "sample.png"), VALID_PNG);

    const result = await resolveVisionImageSource({
      workspaceRoot: workspace,
      path: "images/sample.png",
      maxBytes: 1024
    });

    expect(result).toMatchObject({
      ok: true,
      displayPath: join("images", "sample.png"),
      byteLength: VALID_PNG.byteLength,
      mimeType: "image/png"
    });
  });

  it("rejects traversal to an existing file outside every allowed root", async () => {
    const { root, workspace } = await createWorkspace();
    await writeFile(join(root, "outside.png"), VALID_PNG);

    const result = await resolveVisionImageSource({
      workspaceRoot: workspace,
      path: "../outside.png",
      maxBytes: 1024
    });

    expect(result).toMatchObject({
      ok: false,
      code: "source-outside-allowed-roots"
    });
  });

  it("rejects a symlink that escapes an allowed root", async () => {
    const { root, workspace } = await createWorkspace();
    const outside = join(root, "outside.png");
    await writeFile(outside, VALID_PNG);
    await symlink(outside, join(workspace, "linked.png"));

    const result = await resolveVisionImageSource({
      workspaceRoot: workspace,
      path: "linked.png",
      maxBytes: 1024
    });

    expect(result).toMatchObject({
      ok: false,
      code: "source-outside-allowed-roots"
    });
  });

  it("allows an in-root symlink only after canonical containment", async () => {
    const { workspace } = await createWorkspace();
    const target = join(workspace, "target.png");
    await writeFile(target, VALID_PNG);
    await symlink(target, join(workspace, "linked.png"));

    const result = await resolveVisionImageSource({
      workspaceRoot: workspace,
      path: "linked.png",
      maxBytes: 1024
    });

    expect(result).toMatchObject({
      ok: true,
      displayPath: "target.png",
      mimeType: "image/png"
    });
  });

  it("returns a structured missing-file error without exposing an absolute path", async () => {
    const { workspace } = await createWorkspace();

    const result = await resolveVisionImageSource({
      workspaceRoot: workspace,
      path: "missing.png",
      maxBytes: 1024
    });

    expect(result).toMatchObject({ ok: false, code: "source-not-found" });
    expect(result).not.toHaveProperty("canonicalPath");
    if (!result.ok) {
      expect(result.message).not.toContain(workspace);
    }
  });

  it("requires the resolved source to be a regular file", async () => {
    const { workspace } = await createWorkspace();
    await mkdir(join(workspace, "image.png"));

    const result = await resolveVisionImageSource({
      workspaceRoot: workspace,
      path: "image.png",
      maxBytes: 1024
    });

    expect(result).toMatchObject({
      ok: false,
      code: "source-not-regular-file"
    });
  });

  it("distinguishes a corrupt recognized image from an unsupported file", async () => {
    const { workspace } = await createWorkspace();
    await writeFile(join(workspace, "truncated.png"), VALID_PNG.subarray(0, 20));
    await writeFile(join(workspace, "not-an-image.png"), "plain text");

    const corrupt = await resolveVisionImageSource({
      workspaceRoot: workspace,
      path: "truncated.png",
      maxBytes: 1024
    });
    const unsupported = await resolveVisionImageSource({
      workspaceRoot: workspace,
      path: "not-an-image.png",
      maxBytes: 1024
    });

    expect(corrupt).toMatchObject({ ok: false, code: "source-corrupt" });
    expect(unsupported).toMatchObject({ ok: false, code: "source-unsupported-format" });
  });

  it("uses magic bytes rather than a spoofed filename extension", async () => {
    const { workspace } = await createWorkspace();
    await writeFile(join(workspace, "actually-png.jpg"), VALID_PNG);

    const result = await resolveVisionImageSource({
      workspaceRoot: workspace,
      path: "actually-png.jpg",
      maxBytes: 1024
    });

    expect(result).toMatchObject({ ok: true, mimeType: "image/png" });
  });

  it("resolves channel media within its own canonical root", async () => {
    const { root, workspace } = await createWorkspace();
    const channelMediaRoot = join(root, "channel-media");
    await mkdir(channelMediaRoot);
    await writeFile(join(channelMediaRoot, "upload.bin"), VALID_PNG);

    const result = await resolveVisionImageSource({
      workspaceRoot: workspace,
      allowedRoots: [channelMediaRoot],
      path: join(channelMediaRoot, "upload.bin"),
      maxBytes: 1024
    });

    expect(result).toMatchObject({
      ok: true,
      displayPath: "upload.bin",
      mimeType: "image/png"
    });
  });

  it("allows selected-profile image-cache files but rejects traversal and symlink escapes", async () => {
    const { root, workspace } = await createWorkspace();
    const imageCacheRoot = join(root, "profile", "image-cache");
    await mkdir(imageCacheRoot, { recursive: true });
    const generated = join(imageCacheRoot, "generated.png");
    const outside = join(root, "outside.png");
    await writeFile(generated, VALID_PNG);
    await writeFile(outside, VALID_PNG);
    await symlink(outside, join(imageCacheRoot, "escaped.png"));

    await expect(resolveVisionImageSource({
      workspaceRoot: workspace,
      allowedRoots: [imageCacheRoot],
      path: generated,
      maxBytes: 1024
    })).resolves.toMatchObject({ ok: true, displayPath: "generated.png" });

    await expect(resolveVisionImageSource({
      workspaceRoot: workspace,
      allowedRoots: [imageCacheRoot],
      path: join(imageCacheRoot, "..", "..", "outside.png"),
      maxBytes: 1024
    })).resolves.toMatchObject({ ok: false, code: "source-outside-allowed-roots" });

    await expect(resolveVisionImageSource({
      workspaceRoot: workspace,
      allowedRoots: [imageCacheRoot],
      path: join(imageCacheRoot, "escaped.png"),
      maxBytes: 1024
    })).resolves.toMatchObject({ ok: false, code: "source-outside-allowed-roots" });
  });

  it("stops at the configured byte limit", async () => {
    const { workspace } = await createWorkspace();
    await writeFile(join(workspace, "sample.png"), VALID_PNG);

    const result = await resolveVisionImageSource({
      workspaceRoot: workspace,
      path: "sample.png",
      maxBytes: VALID_PNG.byteLength - 1
    });

    expect(result).toMatchObject({
      ok: false,
      code: "source-too-large",
      details: {
        bytes: VALID_PNG.byteLength,
        limitBytes: VALID_PNG.byteLength - 1
      }
    });
  });
});
