import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FasterWhisperWorkerClient, defaultFasterWhisperWorkerPath } from "./stt-local-whisper.js";

async function jsWorker(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "estacoda-fw-worker-test-"));
  const path = join(dir, "worker.cjs");
  await writeFile(path, source, "utf8");
  await chmod(path, 0o755);
  return path;
}

function jsonLine(payload: string): string {
  return `process.stdout.write(JSON.stringify(${payload}) + "\\n");`;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("FasterWhisperWorkerClient", () => {
  it("starts lazily and reuses one worker process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "estacoda-fw-lazy-"));
    const starts = join(dir, "starts.txt");
    const worker = await jsWorker(`
      const fs = require("fs");
      const readline = require("readline");
      fs.appendFileSync(${JSON.stringify(starts)}, "start\\n");
      readline.createInterface({ input: process.stdin }).on("line", (line) => {
        const req = JSON.parse(line);
        ${jsonLine("{ protocolVersion: 1, id: req.id, ok: true, content: req.type }")}
      });
    `);
    const client = new FasterWhisperWorkerClient({ pythonBinary: process.execPath, workerPath: worker });

    await client.status();
    await client.probe();
    await client.dispose();

    expect((await readFile(starts, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("does not start the worker when disposed before first use", async () => {
    const dir = await mkdtemp(join(tmpdir(), "estacoda-fw-lazy-dispose-"));
    const starts = join(dir, "starts.txt");
    const worker = await jsWorker(`
      require("fs").appendFileSync(${JSON.stringify(starts)}, "start\\n");
    `);
    const client = new FasterWhisperWorkerClient({ pythonBinary: process.execPath, workerPath: worker });

    await client.dispose();

    expect(existsSync(starts)).toBe(false);
  });

  it("applies CUDA fallback through the same worker", async () => {
    const worker = await jsWorker(`
      const readline = require("readline");
      let calls = 0;
      readline.createInterface({ input: process.stdin }).on("line", (line) => {
        const req = JSON.parse(line);
        calls += 1;
        if (calls === 1) {
          ${jsonLine("{ protocolVersion: 1, id: req.id, ok: false, content: 'CUDA device failed', metadata: { errorType: 'CudaError' } }")}
        } else {
          ${jsonLine("{ protocolVersion: 1, id: req.id, ok: true, text: 'cpu transcript', model: req.model, metadata: { device: req.device, computeType: req.computeType } }")}
        }
      });
    `);
    const client = new FasterWhisperWorkerClient({ pythonBinary: process.execPath, workerPath: worker });

    const result = await client.transcribe({ path: "/tmp/audio.wav", model: "base", device: "cuda", computeType: "float16" });
    await client.dispose();

    expect(result.ok).toBe(true);
    expect(result.text).toBe("cpu transcript");
    expect(result.metadata).toMatchObject({ device: "cpu", computeType: "int8" });
  });

  it("restarts once after an unexpected worker exit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "estacoda-fw-restart-"));
    const state = join(dir, "state.txt");
    const worker = await jsWorker(`
      const fs = require("fs");
      const readline = require("readline");
      readline.createInterface({ input: process.stdin }).on("line", (line) => {
        const req = JSON.parse(line);
        if (!fs.existsSync(${JSON.stringify(state)})) {
          fs.writeFileSync(${JSON.stringify(state)}, "exited");
          process.exit(1);
        }
        ${jsonLine("{ protocolVersion: 1, id: req.id, ok: true, text: 'after restart' }")}
      });
    `);
    const client = new FasterWhisperWorkerClient({ pythonBinary: process.execPath, workerPath: worker });

    const result = await client.transcribe({ path: "/tmp/audio.wav", model: "base" });
    await client.dispose();

    expect(result).toMatchObject({ ok: true, text: "after restart" });
  });

  it("marks the client unavailable after a second active unexpected worker exit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "estacoda-fw-active-unavailable-"));
    const starts = join(dir, "starts.txt");
    const worker = await jsWorker(`
      require("fs").appendFileSync(${JSON.stringify(starts)}, "start\\n");
      const readline = require("readline");
      readline.createInterface({ input: process.stdin }).on("line", () => {
        process.exit(1);
      });
    `);
    const client = new FasterWhisperWorkerClient({ pythonBinary: process.execPath, workerPath: worker });

    const result = await client.transcribe({ path: "/tmp/audio.wav", model: "base" });
    const later = await client.status();
    await client.dispose();

    expect(result.ok).toBe(false);
    expect(result.content).toContain("worker-unavailable");
    expect(later).toMatchObject({ ok: false, metadata: { reason: "worker-unavailable" } });
    expect((await readFile(starts, "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("counts idle unexpected exits against the same restart budget", async () => {
    const dir = await mkdtemp(join(tmpdir(), "estacoda-fw-idle-unavailable-"));
    const starts = join(dir, "starts.txt");
    const worker = await jsWorker(`
      require("fs").appendFileSync(${JSON.stringify(starts)}, "start\\n");
      const readline = require("readline");
      readline.createInterface({ input: process.stdin }).on("line", (line) => {
        const req = JSON.parse(line);
        ${jsonLine("{ protocolVersion: 1, id: req.id, ok: true, content: 'ok' }")}
        setTimeout(() => process.exit(1), 10);
      });
    `);
    const client = new FasterWhisperWorkerClient({ pythonBinary: process.execPath, workerPath: worker });

    expect(await client.status()).toMatchObject({ ok: true });
    await delay(50);
    expect(await client.status()).toMatchObject({ ok: true });
    await delay(50);
    const unavailable = await client.status();
    await client.dispose();

    expect(unavailable).toMatchObject({ ok: false, metadata: { reason: "worker-unavailable" } });
    expect((await readFile(starts, "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("returns protocol mismatch failures", async () => {
    const worker = await jsWorker(`
      const readline = require("readline");
      readline.createInterface({ input: process.stdin }).on("line", (line) => {
        const req = JSON.parse(line);
        ${jsonLine("{ protocolVersion: 2, id: req.id, ok: true }")}
      });
    `);
    const client = new FasterWhisperWorkerClient({ pythonBinary: process.execPath, workerPath: worker });

    const result = await client.status();
    await client.dispose();

    expect(result.ok).toBe(false);
    expect(result.content).toContain("protocol mismatch");
  });

  it("enforces queue depth and FIFO order", async () => {
    const worker = await jsWorker(`
      const readline = require("readline");
      readline.createInterface({ input: process.stdin }).on("line", (line) => {
        const req = JSON.parse(line);
        setTimeout(() => {
          ${jsonLine("{ protocolVersion: 1, id: req.id, ok: true, content: req.path }")}
        }, req.path.endsWith("1.wav") ? 30 : 0);
      });
    `);
    const fifo = new FasterWhisperWorkerClient({ pythonBinary: process.execPath, workerPath: worker, queueDepth: 3 });
    const first = fifo.request({ type: "transcribe", path: "/tmp/1.wav" });
    const second = fifo.request({ type: "transcribe", path: "/tmp/2.wav" });
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ content: "/tmp/1.wav" }),
      expect.objectContaining({ content: "/tmp/2.wav" })
    ]);
    await fifo.dispose();

    const overflow = new FasterWhisperWorkerClient({ pythonBinary: process.execPath, workerPath: worker, queueDepth: 1 });
    const active = overflow.request({ type: "status" });
    const denied = await overflow.request({ type: "status" });
    await active;
    await overflow.dispose();
    expect(denied).toMatchObject({ ok: false, metadata: { queueDepth: 1 } });
  });

  it("times out hanging requests", async () => {
    const worker = await jsWorker(`
      const readline = require("readline");
      readline.createInterface({ input: process.stdin }).on("line", () => {});
    `);
    const client = new FasterWhisperWorkerClient({ pythonBinary: process.execPath, workerPath: worker, timeoutMs: 20 });

    const result = await client.status();

    expect(result.ok).toBe(false);
    expect(result.content).toContain("timed out");
  });

  it("kills the worker process group when requests time out", async () => {
    const worker = await jsWorker(`
      const readline = require("readline");
      readline.createInterface({ input: process.stdin }).on("line", () => {});
    `);
    const killedPids: number[] = [];
    const client = new FasterWhisperWorkerClient({
      pythonBinary: process.execPath,
      workerPath: worker,
      timeoutMs: 20,
      killProcess: (pid, signal) => {
        killedPids.push(pid);
        try {
          process.kill(Math.abs(pid), signal);
        } catch {
          // The process may already be gone; the important assertion is the group target.
        }
        return true;
      }
    });

    const result = await client.status();

    expect(result.ok).toBe(false);
    expect(result.content).toContain("timed out");
    expect(killedPids.some((pid) => pid < 0)).toBe(true);
  });

  it("disposes immediately without waiting behind active work", async () => {
    const worker = await jsWorker(`
      const readline = require("readline");
      readline.createInterface({ input: process.stdin }).on("line", () => {});
    `);
    const client = new FasterWhisperWorkerClient({ pythonBinary: process.execPath, workerPath: worker, timeoutMs: 10_000 });
    const active = client.status();

    const disposed = await Promise.race([
      client.dispose().then(() => "disposed"),
      delay(100).then(() => "timeout")
    ]);
    const activeResult = await active;

    expect(disposed).toBe("disposed");
    expect(activeResult).toMatchObject({ ok: false, metadata: { reason: "worker-disposed" } });
  });
});

describe("bundled faster-whisper Python worker", () => {
  it("reports unimportable faster-whisper through probe", async () => {
    const client = new FasterWhisperWorkerClient({
      workerPath: defaultFasterWhisperWorkerPath(),
      timeoutMs: 5_000,
      env: { PYTHONPATH: "" }
    });

    const result = await client.probe();
    await client.dispose();

    expect(result.ok).toBe(false);
    expect(result.metadata).toMatchObject({ importable: false });
  });

  it("reports importable faster-whisper through probe when a module is available", async () => {
    const dir = await mkdtemp(join(tmpdir(), "estacoda-fw-pythonpath-"));
    await writeFile(join(dir, "faster_whisper.py"), "class WhisperModel: pass\n", "utf8");
    const client = new FasterWhisperWorkerClient({
      workerPath: defaultFasterWhisperWorkerPath(),
      timeoutMs: 5_000,
      env: { PYTHONPATH: dir }
    });

    const result = await client.probe();
    await client.dispose();

    expect(result.ok).toBe(true);
    expect(result.metadata).toMatchObject({ importable: true });
  });

  it("passes HF_HOME to the worker process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "estacoda-fw-hf-"));
    const worker = await jsWorker(`
      const readline = require("readline");
      readline.createInterface({ input: process.stdin }).on("line", (line) => {
        const req = JSON.parse(line);
        ${jsonLine("{ protocolVersion: 1, id: req.id, ok: true, content: process.env.HF_HOME }")}
      });
    `);
    const client = new FasterWhisperWorkerClient({
      pythonBinary: process.execPath,
      workerPath: worker,
      env: { HF_HOME: dir }
    });

    const result = await client.status();
    await client.dispose();

    expect(result.content).toBe(dir);
  });
});
