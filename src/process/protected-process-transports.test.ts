import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SecureInputCoordinator } from "../runtime/secure-input-coordinator.js";
import { EphemeralSecretBroker } from "../security/ephemeral-secret-broker.js";
import { SecureInputTransportRegistry } from "../security/secure-input-transport-registry.js";
import { ProcessManager } from "./process-manager.js";
import { createProtectedProcessEnvironmentTransport, createProtectedProcessStdinTransport } from "./protected-process-transports.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("protected process transports", () => {
  it("writes protected stdin bytes only after observing the declared prompt and never interpolates them into the shell", async () => {
    const root = await workspace();
    const outputPath = join(root, "stdin-result.txt");
    const markerPath = join(root, "shell-interpolation-marker");
    const manager = new ProcessManager({ workspaceRoot: root, id: () => "stdin-process" });
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
      `const fs=require('node:fs');const chunks=[];process.stdout.write('Password:');process.stdin.on('data',d=>{chunks.push(d);const all=Buffer.concat(chunks);const end=all.indexOf(10);if(end>=0){fs.writeFileSync(${JSON.stringify(outputPath)},all.subarray(0,end+1));process.exit(0)}})`
    )}`;
    const processRecord = await manager.start(command);
    await waitFor(() => manager.hasObservedPrompt(processRecord.id, "Password:"));
    const secret = `stdin-sentinel-$(touch ${markerPath})`;

    const receipt = await coordinate({
      manager,
      transport: createProtectedProcessStdinTransport(manager),
      request: {
        kind: "password",
        purpose: "CLI sign in",
        retention: "use-once",
        destination: { type: "process-stdin", processId: processRecord.id, promptLabel: "Password:" }
      },
      secret
    });

    await waitFor(async () => (await readFile(outputPath, "utf8")).includes(secret));
    expect(receipt.status).toBe("delivered");
    expect(receipt.destinationLabel).toBe("Password: for process stdin-process");
    expect(await readFile(outputPath, "utf8")).toBe(`${secret}\n`);
    await expect(access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(command).not.toContain(secret);
    expect(manager.logs(processRecord.id)).toEqual([]);
  });

  it("passes a protected value only to one spawned process environment without mutating global process.env", async () => {
    const root = await workspace();
    const outputPath = join(root, "env-result.txt");
    const markerPath = join(root, "env-shell-interpolation-marker");
    const manager = new ProcessManager({ workspaceRoot: root, id: () => "env-process" });
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
      `require('node:fs').writeFileSync(${JSON.stringify(outputPath)},process.env.PROTECTED_TOKEN||'missing')`
    )}`;
    const prepared = await manager.prepareProtectedEnvironment(command, "PROTECTED_TOKEN");
    const secret = `env-sentinel-$(touch ${markerPath})`;
    const original = process.env.PROTECTED_TOKEN;

    const receipt = await coordinate({
      manager,
      transport: createProtectedProcessEnvironmentTransport(manager),
      request: {
        kind: "access-token",
        purpose: "Authenticate one process",
        retention: "use-once",
        destination: { type: "process-environment", processId: prepared.id, variableName: "PROTECTED_TOKEN" }
      },
      secret
    });

    await waitFor(async () => (await readFile(outputPath, "utf8")) === secret);
    expect(receipt.status).toBe("delivered");
    expect(process.env.PROTECTED_TOKEN).toBe(original);
    await expect(access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(command).not.toContain(secret);
    expect(manager.logs(prepared.id)).toEqual([]);
  });
});

async function coordinate(input: {
  manager: ProcessManager;
  transport: ReturnType<typeof createProtectedProcessStdinTransport>;
  request: Parameters<SecureInputCoordinator["request"]>[0]["request"];
  secret: string;
}) {
  const registry = new SecureInputTransportRegistry();
  registry.register(input.transport);
  const broker = new EphemeralSecretBroker({ idFactory: () => "request" });
  try {
    return await new SecureInputCoordinator({
      broker,
      transports: registry,
      collect: async () => ({ status: "provided", value: new TextEncoder().encode(input.secret) })
    }).request({
      scope: { profileId: "profile", sessionId: "session" },
      request: input.request,
      consume: async () => undefined
    });
  } finally {
    broker.dispose();
  }
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "estacoda-protected-process-"));
  roots.push(root);
  return root;
}

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      // Destination output is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for managed process output.");
}
