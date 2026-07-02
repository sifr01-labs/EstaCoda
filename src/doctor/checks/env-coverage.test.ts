import { afterEach, describe, expect, it } from "vitest";
import type { LoadedRuntimeConfig } from "../../config/runtime-config.js";
import { collectMissingProfileEnv, collectProfileEnvReferences } from "./env-coverage.js";

const TRACKED_ENV = [
  "OPENAI_API_KEY",
  "FALLBACK_API_KEY",
  "VISION_API_KEY",
  "BRAVE_SEARCH_API_KEY",
  "FAL_API_KEY",
  "VOICE_TTS_KEY",
  "VOICE_STT_KEY",
  "DISCORD_BOT_TOKEN",
  "EMAIL_PASSWORD"
];

afterEach(() => {
  for (const key of TRACKED_ENV) {
    delete process.env[key];
  }
});

describe("env coverage", () => {
  it("collects env references across model, auxiliary, web, media, and channel surfaces", () => {
    const config = loadedConfig();

    expect([...collectProfileEnvReferences(config)].sort()).toEqual(TRACKED_ENV.sort());
  });

  it("reports only missing env references and never env values", () => {
    process.env.OPENAI_API_KEY = "sk-real-secret-value";
    process.env.BRAVE_SEARCH_API_KEY = "brave-secret-value";

    const missing = collectMissingProfileEnv(loadedConfig());

    expect(missing).not.toContain("OPENAI_API_KEY");
    expect(missing).not.toContain("BRAVE_SEARCH_API_KEY");
    expect(missing.join("\n")).not.toContain("sk-real-secret-value");
    expect(missing).toContain("FALLBACK_API_KEY");
    expect(missing).toContain("VOICE_STT_KEY");
  });

  it("does not treat channel missing field names as env references", () => {
    const config = loadedConfig();
    config.config.channels = {};
    config.channels.discord.missing = ["botTokenEnv"];
    config.channels.email.missing = ["passwordEnv"];

    expect([...collectProfileEnvReferences(config)].sort()).not.toEqual(expect.arrayContaining([
      "botTokenEnv",
      "passwordEnv"
    ]));
  });
});

function loadedConfig(): LoadedRuntimeConfig {
  return {
    config: {
      model: { provider: "openai", id: "gpt-5" },
      providers: {
        openai: { apiKeyEnv: "OPENAI_API_KEY" }
      },
      auxiliaryModels: {
        vision: { provider: "openai", id: "gpt-5", apiKeyEnv: "VISION_API_KEY" }
      },
      web: {
        brave: { apiKeyEnv: "BRAVE_SEARCH_API_KEY" }
      },
      imageGen: {
        provider: "fal",
        fal: { apiKeyEnv: "FAL_API_KEY" }
      },
      tts: {
        provider: "openai",
        openai: { apiKeyEnv: "VOICE_TTS_KEY" }
      },
      stt: {
        provider: "openai",
        openai: { apiKeyEnv: "VOICE_STT_KEY" }
      },
      channels: {
        discord: { enabled: true, botTokenEnv: "DISCORD_BOT_TOKEN" },
        email: { enabled: true, passwordEnv: "EMAIL_PASSWORD" }
      }
    },
    primaryModelRoute: { provider: "openai", id: "gpt-5", apiKeyEnv: "OPENAI_API_KEY" },
    modelFallbackRoutes: [{ provider: "deepseek", id: "deepseek-chat", apiKeyEnv: "FALLBACK_API_KEY" }],
    auxiliaryModels: {
      vision: { provider: "openai", id: "gpt-5", apiKeyEnv: "VISION_API_KEY" }
    },
    web: {
      enableNetwork: true,
      brave: { apiKeyEnv: "BRAVE_SEARCH_API_KEY" }
    },
    imageGen: {
      provider: "fal",
      model: "fal-ai/imagen4/preview",
      useGateway: false,
      apiKeyEnv: "FAL_API_KEY",
      fal: { apiKeyEnv: "FAL_API_KEY" }
    },
    tts: {
      provider: "openai",
      speed: 1,
      openai: { apiKeyEnv: "VOICE_TTS_KEY" }
    },
    stt: {
      provider: "openai",
      openai: { apiKeyEnv: "VOICE_STT_KEY" }
    },
    channels: {
      telegram: { ready: false },
      discord: { ready: false, missing: ["DISCORD_BOT_TOKEN"] },
      email: { ready: false, missing: ["EMAIL_PASSWORD"] },
      whatsapp: { ready: false }
    }
  } as unknown as LoadedRuntimeConfig;
}
