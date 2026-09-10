import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { retainCurrentExecutionOperation } from "../runtime/live-execution-authority.js";
import { DockerContainer, type DockerReceipt } from "./docker-container.js";

// File framing is independent of model command stdout. 8 MiB base64 fits in 12 MiB.
const FRAME_LIMIT = 12 * 1024 * 1024;
let worker: Promise<string> | undefined;

/** A scope owns one lazily prepared, trusted-file-only container. Each RPC gets
 * a fresh isolated Python interpreter; arbitrary commands never run here.
 * Cancellation removes this container, not another scope's execution resources. */
export class DockerFileService {
  #container?: DockerContainer;
  #receipt?: DockerReceipt;
  #starting?: Promise<void>;
  #closing?: Promise<void>;
  #released = false;
  #tail: Promise<unknown> = Promise.resolve();
  #queued = 0;
  #queuedBytes = 0;
  #child?: ChildProcessWithoutNullStreams;
  #cancel?: () => void;
  readonly #authorities = new Set<() => void>();
  readonly #disown: () => void;
  constructor(readonly parent: DockerContainer, readonly homeDir?: string) {
    this.#disown = parent.own(this);
  }
  async #start(): Promise<void> {
    this.#starting ??= (async () => {
      await this.parent.verify();
      if (this.#released) throw new Error("Docker file scope was released.");
      this.#receipt = { name: `estacoda-exec-${randomUUID()}`, owner: randomUUID() };
      this.parent.receipts.write({ ...this.#receipt, schemaVersion: 1, profileId: this.parent.profileId,
        workspaceHash: this.parent.workspace.identityHash, endpoint: this.parent.client.endpoint, creatorPid: process.pid, phase: "planned" });
      this.#container = await DockerContainer.prepare({ client: this.parent.client, profileId: this.parent.profileId,
        workspaceRoot: this.parent.workspace.canonicalPath, homeDir: this.homeDir ?? this.parent.receipts.homeDir,
        policy: this.parent.policy, receipt: this.#receipt });
    })();
    await this.#starting;
  }
  request(input: string): Promise<any> {
    if (this.#released) return Promise.reject(new Error("Docker file scope was released."));
    const bytes = Buffer.byteLength(input);
    if (bytes > FRAME_LIMIT) return Promise.reject(new Error("Workspace request exceeds its limit."));
    if (this.#queued >= 128 || this.#queuedBytes + bytes > 24 * 1024 * 1024) return Promise.reject(new Error("Docker file request queue is full."));
    this.#queued++; this.#queuedBytes += bytes;
    const result = this.#tail.then(async () => {
      if (this.#released) throw new Error("Docker file scope was released.");
      const releaseAuthority = retainCurrentExecutionOperation();
      this.#authorities.add(releaseAuthority);
      let response: any;
      try {
        await this.#start();
        await this.#container!.verify();
        const script = await (worker ??= readFile(new URL("../../workers/docker/files.py", import.meta.url), "utf8"));
        if (this.#released) throw new Error("Docker file scope was released.");
        response = await this.#exchange(script, input);
      } catch (error) {
        try { await this.release(); }
        catch (cleanup) { throw new AggregateError([error, cleanup], "Docker file cleanup is uncertain."); }
        throw error;
      }
      this.#authorities.delete(releaseAuthority); releaseAuthority();
      if (!response.ok) throw Object.assign(new Error(String(response.error)), { code: response.code });
      return response.value;
    });
    this.#tail = result.catch(() => {});
    return result.finally(() => { this.#queued--; this.#queuedBytes -= bytes; });
  }
  #exchange(script: string, input: string): Promise<any> {
    const container = this.#container!;
    return new Promise((accept, reject) => {
      const child = container.client.spawn(["exec", "-i", "--user", container.user, container.id, "python3", "-I", "-c", script]);
      this.#child = child;
      let size = 0, settled = false;
      const chunks: Buffer[] = [];
      const fail = (error: Error) => {
        if (settled) return; settled = true; clearTimeout(timer); this.#cancel = undefined; reject(error);
      };
      const timer = setTimeout(() => fail(new Error("Docker workspace operation timed out; outcome may be uncertain.")), 30_000);
      this.#cancel = () => fail(new Error("Docker file scope was released."));
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > FRAME_LIMIT) fail(new Error("Docker workspace response exceeds its limit."));
        else if (!settled) chunks.push(chunk);
      });
      child.stderr.on("data", () => {});
      child.stdin.on("error", () => fail(new Error("Docker workspace input transport failed.")));
      child.once("error", () => fail(new Error("Docker workspace transport failed.")));
      child.once("close", (code) => {
        if (settled) return;
        try {
          if (code !== 0) throw new Error("Docker workspace operation failed; host fallback is disabled.");
          const response = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!response || typeof response.ok !== "boolean") throw new Error("Invalid Docker file response.");
          settled = true; clearTimeout(timer); this.#cancel = undefined; this.#child = undefined; accept(response);
        } catch { fail(new Error("Docker workspace operation failed; host fallback is disabled.")); }
      });
      child.stdin.end(input);
    });
  }
  async release(): Promise<void> {
    this.#released = true;
    this.#cancel?.();
    this.#closing ??= (async () => {
      // Let creation finish: killing a create client could falsely report absence.
      await this.#starting?.catch(() => {});
      try {
        if (this.#container) await this.#container.release();
        else if (this.#receipt) await this.parent.receipts.clean(this.parent.client, this.#receipt);
      } finally {
        // CLI termination alone is never proof that in-container work settled.
        this.#child?.kill("SIGKILL");
      }
      for (const release of this.#authorities) release();
      this.#authorities.clear(); this.#disown();
    })();
    try { await this.#closing; } catch (error) { this.#closing = undefined; throw error; }
  }
}
