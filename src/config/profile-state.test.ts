import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProfileStateHome } from "./profile-home.js";
import { PersistentChannelSessionStore } from "../channels/channel-session-store.js";
import { runGatewaySupervisor } from "../gateway/supervisor.js";

const tempDirs: string[] = [];

async function makeTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "estacoda-profile-state-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

async function expectFileMissing(path: string): Promise<void> {
  await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
}

describe("profile runtime state paths", () => {
  it("selected profile changes skill scan path", async () => {
    const homeDir = await makeTempHome();

    const alpha = resolveProfileStateHome({ homeDir, profileId: "alpha" });
    const beta = resolveProfileStateHome({ homeDir, profileId: "beta" });

    expect(alpha.skillsPath).toBe(join(homeDir, ".estacoda", "profiles", "alpha", "skills"));
    expect(beta.skillsPath).toBe(join(homeDir, ".estacoda", "profiles", "beta", "skills"));
    expect(alpha.skillsPath).not.toBe(beta.skillsPath);
  });

  it("gateway state path includes selected profile", async () => {
    const homeDir = await makeTempHome();

    const paths = resolveProfileStateHome({ homeDir, profileId: "ops" });

    expect(paths.gatewayStatePath).toBe(join(homeDir, ".estacoda", "profiles", "ops", "gateway"));
  });

  it("channel session store is profile-local when backed by gateway state", async () => {
    const homeDir = await makeTempHome();
    const alphaPaths = resolveProfileStateHome({ homeDir, profileId: "alpha" });
    const betaPaths = resolveProfileStateHome({ homeDir, profileId: "beta" });
    const alphaStore = new PersistentChannelSessionStore({
      path: join(alphaPaths.gatewayStatePath, "channel-sessions.json"),
    });
    const betaStore = new PersistentChannelSessionStore({
      path: join(betaPaths.gatewayStatePath, "channel-sessions.json"),
    });

    const sessionKey = { platform: "telegram" as const, chatId: "chat-1" };
    const alphaSession = await alphaStore.getOrCreateSessionId(sessionKey, { receivedAt: "2026-01-01T00:00:00.000Z" });
    const betaSession = await betaStore.getOrCreateSessionId(sessionKey, { receivedAt: "2026-01-01T00:00:00.000Z" });

    expect(alphaSession).toBe("channel-telegram-default-dm-chat-1-main");
    expect(betaSession).toBe("channel-telegram-default-dm-chat-1-main");

    await alphaStore.setSessionId?.(sessionKey, "alpha-session", { receivedAt: "2026-01-01T00:01:00.000Z" });

    expect(await alphaStore.getOrCreateSessionId(sessionKey, { receivedAt: "2026-01-01T00:02:00.000Z" })).toBe("alpha-session");
    expect(await betaStore.getOrCreateSessionId(sessionKey, { receivedAt: "2026-01-01T00:02:00.000Z" })).toBe("channel-telegram-default-dm-chat-1-main");
  });

  it("gateway supervisor wires channel and delivery state to the bound profile", async () => {
    const homeDir = await makeTempHome();
    const betaPaths = resolveProfileStateHome({ homeDir, profileId: "beta" });
    const alphaPaths = resolveProfileStateHome({ homeDir, profileId: "alpha" });
    let gatewayOptions: ConstructorParameters<typeof import("../channels/channel-gateway.js").ChannelGateway>[0] | undefined;
    let routerOptions: ConstructorParameters<typeof import("../channels/delivery-router.js").DeliveryRouter>[0] | undefined;

    const result = await runGatewaySupervisor({
      workspaceRoot: homeDir,
      homeDir,
      profileId: "beta",
      once: true,
      factories: {
        createDeliveryRouter(input) {
          routerOptions = input;
          return {
            registerAdapter() {},
            parseTarget() {
              return [];
            },
            async deliverText() {
              return new Map();
            },
            getRegisteredPlatforms() {
              return [];
            },
          } as unknown as import("../channels/delivery-router.js").DeliveryRouter;
        },
        createChannelGateway(input) {
          gatewayOptions = input;
          return {
            async start() {},
            async stop() {},
            hasPendingWork() {
              return false;
            },
          } as unknown as import("../channels/channel-gateway.js").ChannelGateway;
        },
        async tickCron() {
          return [];
        },
        async sleep() {},
        exit() {},
      },
    });

    expect(result.ok).toBe(true);
    expect(routerOptions?.deliveryRoot).toBe(join(betaPaths.gatewayStatePath, "delivery"));
    expect(routerOptions?.deliveryErrorLogPath).toBe(join(betaPaths.gatewayStatePath, "logs", "delivery-errors.jsonl"));
    expect(gatewayOptions?.profileId).toBe("beta");
    expect(gatewayOptions?.sessionStore).toBeDefined();

    const sessionKey = { platform: "telegram" as const, chatId: "chat-1" };
    await gatewayOptions!.sessionStore!.getOrCreateSessionId(sessionKey, { receivedAt: "2026-01-01T00:00:00.000Z" });

    const betaSessionPath = join(betaPaths.gatewayStatePath, "channel-sessions.json");
    expect(await readFile(betaSessionPath, "utf8")).toContain("chat-1");
    await expectFileMissing(join(alphaPaths.gatewayStatePath, "channel-sessions.json"));
    await expectFileMissing(join(homeDir, ".estacoda", "channel-sessions.json"));
  });

});
