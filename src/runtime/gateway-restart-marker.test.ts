import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveProfileStateHome } from "../config/profile-home.js";
import {
  clearGatewayRestartPlannedMarker,
  gatewayRestartPlannedMarkerPath,
  isGatewayRestartPlannedMarkerProfileLocal,
  readGatewayRestartPlannedMarker,
  writeGatewayRestartPlannedMarker
} from "./gateway-restart-marker.js";

async function createProfilePaths() {
  const homeDir = await mkdtemp(join(tmpdir(), "estacoda-gateway-restart-marker-"));
  const profilePaths = resolveProfileStateHome({ homeDir, profileId: "default" });
  await mkdir(profilePaths.gatewayStatePath, { recursive: true });
  return { homeDir, profilePaths };
}

describe("gateway restart planned marker", () => {
  it("reads missing marker as undefined", async () => {
    const { profilePaths } = await createProfilePaths();

    await expect(readGatewayRestartPlannedMarker(profilePaths)).resolves.toBeUndefined();
  });

  it("writes and reads a marker", async () => {
    const { profilePaths } = await createProfilePaths();
    const marker = {
      plannedAt: "2026-06-18T10:00:00.000Z",
      reason: "gateway-restart" as const
    };

    await writeGatewayRestartPlannedMarker(profilePaths, marker);

    await expect(readGatewayRestartPlannedMarker(profilePaths)).resolves.toEqual(marker);
    const persisted = JSON.parse(await readFile(gatewayRestartPlannedMarkerPath(profilePaths), "utf8")) as Record<string, unknown>;
    expect(persisted).toEqual(marker);
    expect(Object.keys(persisted).sort()).toEqual(["plannedAt", "reason"]);
    for (const forbiddenKey of [
      "recipient",
      "recipients",
      "thread",
      "threadId",
      "chat",
      "chatId",
      "session",
      "sessionId",
      "resume",
      "channel",
      "channels",
    ]) {
      expect(persisted).not.toHaveProperty(forbiddenKey);
    }
  });

  it("clears an existing marker", async () => {
    const { profilePaths } = await createProfilePaths();
    await writeGatewayRestartPlannedMarker(profilePaths, {
      plannedAt: "2026-06-18T10:00:00.000Z",
      reason: "update"
    });

    await clearGatewayRestartPlannedMarker(profilePaths);

    await expect(readGatewayRestartPlannedMarker(profilePaths)).resolves.toBeUndefined();
  });

  it("clears a missing marker without throwing", async () => {
    const { profilePaths } = await createProfilePaths();

    await expect(clearGatewayRestartPlannedMarker(profilePaths)).resolves.toBeUndefined();
  });

  it("handles malformed marker content safely", async () => {
    const { profilePaths } = await createProfilePaths();
    await writeFile(gatewayRestartPlannedMarkerPath(profilePaths), "{ not valid json", "utf8");

    await expect(readGatewayRestartPlannedMarker(profilePaths)).resolves.toBeUndefined();
  });

  it("rejects unknown marker reasons", async () => {
    const { profilePaths } = await createProfilePaths();
    await writeFile(gatewayRestartPlannedMarkerPath(profilePaths), JSON.stringify({
      plannedAt: "2026-06-18T10:00:00.000Z",
      reason: "manual"
    }), "utf8");

    await expect(readGatewayRestartPlannedMarker(profilePaths)).resolves.toBeUndefined();
    await expect(writeGatewayRestartPlannedMarker(profilePaths, {
      plannedAt: "2026-06-18T10:00:00.000Z",
      reason: "manual" as never
    })).rejects.toThrow("Invalid gateway restart planned marker");
  });

  it("resolves marker path under profile-local gateway state", async () => {
    const { profilePaths } = await createProfilePaths();

    expect(gatewayRestartPlannedMarkerPath(profilePaths)).toBe(join(profilePaths.gatewayStatePath, "restart-planned.json"));
    expect(isGatewayRestartPlannedMarkerProfileLocal(profilePaths)).toBe(true);
  });

  it("writes atomically without leaving temp files", async () => {
    const { profilePaths } = await createProfilePaths();

    await writeGatewayRestartPlannedMarker(profilePaths, {
      plannedAt: "2026-06-18T10:00:00.000Z",
      reason: "gateway-restart"
    });

    const entries = await readdir(profilePaths.gatewayStatePath);
    expect(entries).toContain("restart-planned.json");
    expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });
});
