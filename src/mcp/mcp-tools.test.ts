import { describe, expect, it } from "vitest";
import { loadMcpServers, resolveMcpEnvironment } from "./mcp-tools.js";

describe("resolveMcpEnvironment", () => {
  it("resolves explicitly named environment references without exposing unrelated values", () => {
    const result = resolveMcpEnvironment(
      {
        env: { LOG_LEVEL: "warn" },
        envRefs: { POSTMAN_API_KEY: "PROFILE_POSTMAN_API_KEY" },
      },
      {
        PROFILE_POSTMAN_API_KEY: "postman-secret-value",
        UNRELATED_SECRET: "must-not-be-forwarded",
      },
    );

    expect(result).toEqual({
      ok: true,
      env: {
        LOG_LEVEL: "warn",
        POSTMAN_API_KEY: "postman-secret-value",
      },
    });
  });

  it("fails closed when a referenced environment variable is missing", () => {
    expect(resolveMcpEnvironment(
      { envRefs: { POSTMAN_API_KEY: "PROFILE_POSTMAN_API_KEY" } },
      {},
    )).toEqual({
      ok: false,
      error: "MCP environment variable PROFILE_POSTMAN_API_KEY is not set.",
    });
  });

  it("rejects invalid environment variable names", () => {
    expect(resolveMcpEnvironment(
      { envRefs: { POSTMAN_API_KEY: "PROFILE-POSTMAN-API-KEY" } },
      { "PROFILE-POSTMAN-API-KEY": "postman-secret-value" },
    )).toEqual({
      ok: false,
      error: "MCP environment reference POSTMAN_API_KEY is invalid.",
    });
  });
});

describe("loadMcpServers environment references", () => {
  it("marks a server unavailable before launch when its referenced secret is missing", async () => {
    const [loaded] = await loadMcpServers({
      servers: {
        postman: {
          command: "command-that-must-not-run",
          envRefs: { POSTMAN_API_KEY: "POSTMAN_API_KEY" },
        },
      },
      environment: {},
    });

    expect(loaded?.snapshot).toMatchObject({
      name: "postman",
      available: false,
      error: "MCP environment variable POSTMAN_API_KEY is not set.",
    });
  });
});
