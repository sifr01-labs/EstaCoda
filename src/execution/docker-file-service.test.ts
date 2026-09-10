import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { DockerContainer } from "./docker-container.js";
import { DockerFileService } from "./docker-file-service.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture(output = JSON.stringify({ ok: true, value: "hello" }), stalled = false) {
  const children: Array<ReturnType<typeof child>> = [];
  function child() {
    return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  }
  const release = vi.fn().mockResolvedValue(undefined), disown = vi.fn();
  const container = { id: "owned", user: "1000:1000", verify: vi.fn().mockResolvedValue(undefined), release,
    client: { spawn: vi.fn(() => {
      const process = child(); children.push(process);
      process.stdin.on("finish", () => {
        if (!stalled) { process.stdout.emit("data", Buffer.from(output)); process.emit("close", 0); }
      }); return process;
    }) } };
  const parent = { verify: vi.fn().mockResolvedValue(undefined), own: vi.fn(() => disown),
    workspace: { canonicalPath: "/workspace", identityHash: "hash" }, client: { endpoint: "unix:///docker.sock" },
    receipts: { write: vi.fn(), clean: vi.fn(), homeDir: "/tmp" } } as unknown as DockerContainer;
  const prepare = vi.spyOn(DockerContainer, "prepare").mockResolvedValue(container as unknown as DockerContainer);
  return { service: new DockerFileService(parent), parent, container, prepare, release, disown, children };
}
it("reuses the verified file container and transfers 8 MiB independently of command output limits", async () => {
  const value = Buffer.alloc(8 * 1024 * 1024, "a").toString("base64");
  const f = fixture(JSON.stringify({ ok: true, value }));
  try {
    for (let i = 0; i < 3; i++) expect(await f.service.request("{}")).toBe(value);
    expect(f.prepare).toHaveBeenCalledOnce(); expect(f.container.verify).toHaveBeenCalledTimes(3);
    expect(f.container.client.spawn.mock.calls[0]).toEqual([expect.arrayContaining(["-I"])]);
  } finally { await f.service.release(); }
  expect(f.release).toHaveBeenCalledOnce(); expect(f.disown).toHaveBeenCalledOnce();
});
it("cancels queued/inflight file work and retries uncertain cleanup without disowning it", async () => {
  const f = fixture("", true);
  const pending = f.service.request("{}"); const queued = f.service.request("{}");
  const results = Promise.allSettled([pending, queued]);
  await vi.waitFor(() => expect(f.children).toHaveLength(1));
  f.release.mockRejectedValueOnce(new Error("daemon unavailable"));
  await expect(f.service.release()).rejects.toThrow("unavailable");
  expect(f.disown).not.toHaveBeenCalled();
  await f.service.release();
  expect((await results).every((r) => r.status === "rejected")).toBe(true);
  expect(f.release).toHaveBeenCalledTimes(2); expect(f.disown).toHaveBeenCalledOnce();
  expect(f.children[0]!.kill).toHaveBeenCalledWith("SIGKILL");
  await expect(f.service.request("{}")).rejects.toThrow("released");
});
it.each(["invalid JSON", "x".repeat(12 * 1024 * 1024 + 1)])("removes only the owned file container on invalid transport (%#)", async (output) => {
  const f = fixture(output);
  await expect(f.service.request("{}")).rejects.toThrow(/operation failed|exceeds/);
  expect(f.release).toHaveBeenCalledOnce(); expect(f.disown).toHaveBeenCalledOnce();
});
it("keeps ordinary file errors recoverable without discarding the container", async () => {
  const f = fixture(JSON.stringify({ ok: false, error: "missing", code: "ENOENT" }));
  try {
    await expect(f.service.request("{}")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(f.service.request("{}")).rejects.toThrow("missing");
    expect(f.prepare).toHaveBeenCalledOnce(); expect(f.release).not.toHaveBeenCalled();
  } finally { await f.service.release(); }
});
it("times out stalled file work and confirms owned container cleanup", async () => {
  vi.useFakeTimers();
  const f = fixture("", true);
  const pending = expect(f.service.request("{}")).rejects.toThrow("timed out");
  await vi.waitFor(() => expect(f.children).toHaveLength(1));
  await vi.advanceTimersByTimeAsync(30_000);
  await pending;
  expect(f.release).toHaveBeenCalledOnce(); expect(f.disown).toHaveBeenCalledOnce();
});
it("waits for creation before releasing, without starting a cancelled RPC", async () => {
  const f = fixture();
  let finish!: (container: DockerContainer) => void;
  f.prepare.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const pending = expect(f.service.request("{}")).rejects.toThrow(/released|unavailable/);
  await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce());
  const closing = f.service.release();
  expect(f.release).not.toHaveBeenCalled();
  finish(f.container as unknown as DockerContainer);
  await closing; await pending;
  expect(f.release).toHaveBeenCalledOnce(); expect(f.container.client.spawn).not.toHaveBeenCalled();
});
it("retains uncertain creation receipts for explicit cleanup retry", async () => {
  const f = fixture();
  f.prepare.mockRejectedValue(new Error("creation uncertain"));
  vi.mocked(f.parent.receipts.clean).mockRejectedValueOnce(new Error("still uncertain")).mockResolvedValue(undefined);
  await expect(f.service.request("{}")).rejects.toThrow("cleanup is uncertain");
  expect(f.disown).not.toHaveBeenCalled();
  await f.service.release();
  expect(f.parent.receipts.clean).toHaveBeenCalledTimes(2); expect(f.disown).toHaveBeenCalledOnce();
});
it("bounds queued input bytes before allocating more worker requests", async () => {
  const f = fixture("", true);
  const input = "x".repeat(12 * 1024 * 1024);
  const first = f.service.request(input), second = f.service.request(input);
  const pending = Promise.allSettled([first, second]);
  await expect(f.service.request("{}")).rejects.toThrow("queue is full");
  await f.service.release();
  expect((await pending).every((result) => result.status === "rejected")).toBe(true);
});
