import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DockerReceipts } from "./docker-receipts.js";
import { cleanupDockerReceipt, DOCKER_OWNER_LABEL } from "./docker-container.js";
import type { DockerClient } from "./docker-client.js";
it("retains uncertain creation receipts and never removes a foreign resource", async () => {
  const home = await mkdtemp(join(tmpdir(), "docker-receipt-test-"));
  const store = new DockerReceipts("test", home), owner = randomUUID();
  const entry = { schemaVersion: 1 as const, owner, name: `estacoda-exec-${randomUUID()}`, creatorPid: process.pid, profileId: "test", workspaceHash: "a".repeat(64), endpoint: "unix:///example.sock", phase: "creating" as const };
  const run = vi.fn(async () => ""); const client = { endpoint: entry.endpoint, run } as unknown as DockerClient;
  try {
    store.write(entry);
    await expect(store.clean(client, entry)).rejects.toThrow("uncertain"); expect(store.read(owner)?.phase).toBe("creating");
    await store.recover(client, entry.workspaceHash); expect(run).toHaveBeenCalledTimes(1); // live owner is untouched
    run.mockImplementation(async (args?: readonly string[]) => args?.[0] === "inspect" ? JSON.stringify([{ Id: "b".repeat(64), Config: { Labels: { [DOCKER_OWNER_LABEL]: "foreign" } } }]) : "b".repeat(64));
    await expect(cleanupDockerReceipt(client, entry)).rejects.toThrow("ownership");
    expect(run.mock.calls.some((args) => (args as unknown as string[][])[0]?.[0] === "rm")).toBe(false);
    run.mockImplementation(async () => ""); store.write({ ...entry, phase: "planned" });
    await store.clean(client, entry); expect(store.read(owner)).toBeUndefined();
  } finally { await rm(home, { recursive: true, force: true }); }
});
