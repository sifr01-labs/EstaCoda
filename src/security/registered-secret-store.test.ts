import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecureInputCoordinator } from "../runtime/secure-input-coordinator.js";
import { EphemeralSecretBroker } from "./ephemeral-secret-broker.js";
import { createProfileEnvSecretStore, createRegisteredSecretStoreTransport, RegisteredSecretStoreRegistry } from "./registered-secret-store.js";
import { SecureInputTransportRegistry } from "./secure-input-transport-registry.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("registered secret-store transport", () => {
  it("denies persistence without explicit authorization and writes only to the active profile after approval", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "estacoda-protected-store-"));
    roots.push(homeDir);
    const stores = new RegisteredSecretStoreRegistry();
    stores.register(createProfileEnvSecretStore({ homeDir, profileId: "active" }));
    const transports = new SecureInputTransportRegistry();
    transports.register(createRegisteredSecretStoreTransport(stores));
    const broker = new EphemeralSecretBroker({ idFactory: () => "store-request" });
    const secret = "registered-store-sentinel";
    const request = {
      kind: "api-key" as const,
      purpose: "Save provider key",
      retention: "profile-secret-store" as const,
      destination: { type: "registered-store" as const, storeId: "profile-env", entryName: "PROVIDER_API_KEY" }
    };
    const collect = vi.fn(async () => ({ status: "provided" as const, value: new TextEncoder().encode(secret) }));

    const denied = await new SecureInputCoordinator({ broker, transports, collect }).request({
      scope: { profileId: "active", sessionId: "session" }, request, consume: async () => undefined
    });
    expect(denied.status).toBe("failed");
    expect(collect).not.toHaveBeenCalled();

    const approved = await new SecureInputCoordinator({
      broker,
      transports,
      collect,
      authorize: async () => "approved"
    }).request({
      scope: { profileId: "active", sessionId: "session" }, request, consume: async () => undefined
    });
    const path = join(homeDir, ".estacoda", "profiles", "active", ".env");
    expect(approved).toMatchObject({ status: "delivered", persisted: true });
    expect(approved.destinationLabel).toBe("PROVIDER_API_KEY in registered store profile-env");
    expect(await readFile(path, "utf8")).toContain(`PROVIDER_API_KEY="${secret}"`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(readFile(join(homeDir, ".estacoda", "profiles", "other", ".env"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    broker.dispose();
  });
});
