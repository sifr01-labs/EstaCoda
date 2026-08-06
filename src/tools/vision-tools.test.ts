import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyzeImageWithVision, createVisionTools } from "./vision-tools.js";
import type { ProviderExecutionResult, ProviderExecutor } from "../providers/provider-executor.js";
import type { ResolvedModelRoute } from "../contracts/provider.js";

function createMockExecutor(ok = true, content = "vision result") {
  const fn = vi.fn().mockResolvedValue({
    ok,
    response: ok ? {
      content,
      provider: "openai",
      model: "gpt-4o"
    } : undefined,
    attempts: [{ provider: "openai", model: "gpt-4o", ok, content: ok ? "ok" : "failed", errorClass: ok ? undefined : "network" }]
  });
  return {
    complete: fn as unknown as ProviderExecutor["complete"]
  } as unknown as ProviderExecutor;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function successfulExecution(route: ResolvedModelRoute, content: string): ProviderExecutionResult {
  return {
    ok: true,
    response: {
      ok: true,
      content,
      provider: route.provider,
      model: route.id
    },
    fallbackUsed: false,
    attempts: [{
      provider: route.provider,
      model: route.id,
      state: "dispatched",
      dispatchedAt: "2030-01-01T00:00:00.000Z",
      ok: true,
      content
    }],
    toolCalls: []
  };
}

function createTempPng(): { dir: string; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "estacoda-vision-test-"));
  const path = join(dir, "test.png");
  writeFileSync(path, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    "base64"
  ));
  return { dir, path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const baseRoute: ResolvedModelRoute = {
  provider: "openai",
  id: "gpt-4o",
  profile: {
    id: "gpt-4o",
    provider: "openai",
    contextWindowTokens: 128000,
    supportsTools: true,
    supportsVision: true,
    supportsStructuredOutput: true
  },
  baseUrl: "https://api.openai.com/v1",
  apiKeyEnv: "OPENAI_API_KEY"
};

const textOnlyRoute: ResolvedModelRoute = {
  ...baseRoute,
  id: "text-only",
  profile: {
    ...baseRoute.profile,
    id: "text-only",
    supportsVision: false
  }
};

describe("vision tools", () => {
  describe("createVisionTools", () => {
    it("returns vision.analyze tool", () => {
      const tools = createVisionTools({ workspaceRoot: "/tmp" });
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("vision.analyze");
    });

    it("reports unavailable when resolvedVisionRoute is undefined", async () => {
      const tools = createVisionTools({ workspaceRoot: "/tmp" });
      const available = await tools[0].isAvailable?.();
      expect(available).toBe(false);
    });

    it("reports available when resolvedVisionRoute is defined", async () => {
      const tools = createVisionTools({
        workspaceRoot: "/tmp",
        resolvedVisionRoute: baseRoute
      });
      const available = await tools[0].isAvailable?.();
      expect(available).toBe(true);
    });

    it("reports unavailable when a configured route lacks vision capability", async () => {
      const tools = createVisionTools({
        workspaceRoot: "/tmp",
        resolvedVisionRoute: textOnlyRoute
      });
      const available = await tools[0].isAvailable?.();
      expect(available).toBe(false);
    });
  });

  describe("analyzeImageWithVision", () => {
    it("returns unavailable when no route resolved", async () => {
      const tmp = createTempPng();
      try {
        const result = await analyzeImageWithVision(
          { workspaceRoot: tmp.dir },
          { path: "test.png" }
        );
        expect(result.ok).toBe(false);
        expect(result.content).toContain("No vision-capable provider route");
      } finally {
        tmp.cleanup();
      }
    });

    it("uses resolved auxiliary route through ProviderExecutor", async () => {
      const executor = createMockExecutor();
      const tmp = createTempPng();
      try {
        const result = await analyzeImageWithVision(
          {
            workspaceRoot: tmp.dir,
            visionAuxiliaryRoute: {
              task: "vision",
              route: baseRoute,
              source: "explicit",
              fallbackToMain: false,
              timeoutMs: 123,
              maxConcurrency: 2,
              diagnostics: []
            },
            providerExecutor: executor,
            routePreferences: { requireVision: false }
          },
          { path: "test.png" }
        );

        expect(executor.complete).toHaveBeenCalledTimes(1);
        const [request, preferences, executionOptions] = (executor.complete as any).mock.calls[0];
        expect(preferences).toEqual(expect.objectContaining({ requireVision: true }));
        expect(executionOptions!.primaryRoute).toEqual(baseRoute);
        expect(executionOptions!.signal).toBeDefined();
        expect(request.messages[1].content[1].image_url.url).toMatch(/^data:image\/png;base64,/u);
        expect(result.ok).toBe(true);
        expect(result.metadata).toEqual(expect.objectContaining({
          path: "test.png",
          mimeType: "image/png",
          width: 1,
          height: 1,
          metadataStripped: true
        }));
      } finally {
        tmp.cleanup();
      }
    });

    it("rejects a non-vision auxiliary route before provider execution", async () => {
      const executor = createMockExecutor();
      const tmp = createTempPng();
      try {
        const result = await analyzeImageWithVision(
          {
            workspaceRoot: tmp.dir,
            visionAuxiliaryRoute: {
              task: "vision",
              route: textOnlyRoute,
              source: "explicit",
              fallbackToMain: false,
              diagnostics: []
            },
            providerExecutor: executor
          },
          { path: "test.png" }
        );

        expect(result.ok).toBe(false);
        expect(result.content).toContain("No vision-capable provider route");
        expect(executor.complete).not.toHaveBeenCalled();
      } finally {
        tmp.cleanup();
      }
    });

    it("returns a structured degraded result when image normalization is unavailable", async () => {
      const executor = createMockExecutor();
      const tmp = createTempPng();
      try {
        const result = await analyzeImageWithVision(
          {
            workspaceRoot: tmp.dir,
            visionAuxiliaryRoute: {
              task: "vision",
              route: baseRoute,
              source: "explicit",
              fallbackToMain: false,
              diagnostics: []
            },
            providerExecutor: executor,
            imageNormalizer: {
              normalize: vi.fn().mockResolvedValue({
                ok: false,
                code: "normalization-unavailable",
                message: "Vision image processing is unavailable in this installation."
              })
            }
          },
          { path: "test.png" }
        );

        expect(result).toEqual({
          ok: false,
          content: "Vision image processing is unavailable in this installation.",
          metadata: {
            path: "test.png",
            errorCode: "normalization-unavailable"
          }
        });
        expect(executor.complete).not.toHaveBeenCalled();
      } finally {
        tmp.cleanup();
      }
    });

    it("fails loudly when auxiliary vision returns empty content", async () => {
      const executor = createMockExecutor(true, "   ");
      const tmp = createTempPng();
      try {
        const result = await analyzeImageWithVision(
          {
            workspaceRoot: tmp.dir,
            visionAuxiliaryRoute: {
              task: "vision",
              route: baseRoute,
              source: "explicit",
              fallbackToMain: false,
              diagnostics: []
            },
            providerExecutor: executor
          },
          { path: "test.png" }
        );

        expect(result.ok).toBe(false);
        expect(result.content).toContain("returned no usable content");
        expect(result.content).toContain("openai/gpt-4o:ok");
        expect(result.metadata).toEqual(expect.objectContaining({
          path: "test.png",
          provider: "openai",
          model: "gpt-4o",
          attempts: ["openai/gpt-4o:ok"]
        }));
      } finally {
        tmp.cleanup();
      }
    });

    it("passes task vision through the full auxiliary route", async () => {
      const executor = createMockExecutor();
      const tmp = createTempPng();
      try {
        await analyzeImageWithVision(
          {
            workspaceRoot: tmp.dir,
            visionAuxiliaryRoute: {
              task: "vision",
              route: baseRoute,
              source: "explicit",
              fallbackToMain: false,
              diagnostics: []
            },
            providerExecutor: executor
          },
          { path: "test.png" }
        );

        expect(executor.complete).toHaveBeenCalledTimes(1);
        expect((executor.complete as any).mock.calls[0][2].primaryRoute).toEqual(baseRoute);
      } finally {
        tmp.cleanup();
      }
    });

    it("preserves route-level baseUrl and apiKeyEnv", async () => {
      const executor = createMockExecutor();
      const tmp = createTempPng();
      try {
        await analyzeImageWithVision(
          {
            workspaceRoot: tmp.dir,
            resolvedVisionRoute: baseRoute,
            providerExecutor: executor
          },
          { path: "test.png" }
        );

        const [, , executionOptions] = (executor.complete as any).mock.calls[0];
        expect(executionOptions!.primaryRoute!.baseUrl).toBe("https://api.openai.com/v1");
        expect(executionOptions!.primaryRoute!.apiKeyEnv).toBe("OPENAI_API_KEY");
      } finally {
        tmp.cleanup();
      }
    });

    it("fallback-to-main works only when allowed and main supports vision", async () => {
      const mainRoute: ResolvedModelRoute = {
        provider: "anthropic",
        id: "claude-3",
        profile: {
          id: "claude-3",
          provider: "anthropic",
          contextWindowTokens: 200000,
          supportsTools: true,
          supportsVision: true,
          supportsStructuredOutput: true
        }
      };

      let callCount = 0;
      const failingThenOkExecutor = {
        complete: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return Promise.resolve({
              ok: false,
              attempts: [{ provider: "openai", model: "gpt-4o", ok: false, content: "failed", errorClass: "network" }]
            });
          }
          return Promise.resolve({
            ok: true,
            response: {
              content: "fallback result",
              provider: "anthropic",
              model: "claude-3"
            },
            attempts: [{ provider: "anthropic", model: "claude-3", ok: true, content: "ok" }]
          });
        })
      } as unknown as ProviderExecutor;

      const tmp = createTempPng();
      try {
        const result = await analyzeImageWithVision(
          {
            workspaceRoot: tmp.dir,
            visionAuxiliaryRoute: {
              task: "vision",
              route: baseRoute,
              source: "explicit",
              fallbackToMain: true,
              diagnostics: []
            },
            mainRoute,
            providerExecutor: failingThenOkExecutor
          },
          { path: "test.png" }
        );

        expect(failingThenOkExecutor.complete).toHaveBeenCalledTimes(2);
        const [, , firstOptions] = (failingThenOkExecutor.complete as any).mock.calls[0];
        expect(firstOptions!.primaryRoute).toEqual(baseRoute);
        const [, , secondOptions] = (failingThenOkExecutor.complete as any).mock.calls[1];
        expect(secondOptions!.primaryRoute).toEqual(mainRoute);
        expect(result.ok).toBe(true);
        expect(result.content).toContain("fallback result");
      } finally {
        tmp.cleanup();
      }
    });

    it("does not fallback when main does not support vision", async () => {
      const executor = createMockExecutor(false);
      const mainRoute: ResolvedModelRoute = {
        provider: "local",
        id: "qwen2.5:3b",
        profile: {
          id: "qwen2.5:3b",
          provider: "local",
          contextWindowTokens: 32000,
          supportsTools: true,
          supportsVision: false,
          supportsStructuredOutput: true
        }
      };

      const tmp = createTempPng();
      try {
        const result = await analyzeImageWithVision(
          {
            workspaceRoot: tmp.dir,
            visionAuxiliaryRoute: {
              task: "vision",
              route: baseRoute,
              source: "explicit",
              fallbackToMain: false,
              diagnostics: []
            },
            mainRoute,
            providerExecutor: executor
          },
          { path: "test.png" }
        );

        expect(executor.complete).toHaveBeenCalledTimes(1);
        expect(result.ok).toBe(false);
      } finally {
        tmp.cleanup();
      }
    });

    it("does not fallback when fallbackToMain is false", async () => {
      const executor = createMockExecutor(false);
      const mainRoute: ResolvedModelRoute = {
        provider: "openai",
        id: "gpt-4o",
        profile: {
          id: "gpt-4o",
          provider: "openai",
          contextWindowTokens: 128000,
          supportsTools: true,
          supportsVision: true,
          supportsStructuredOutput: true
        }
      };

      const tmp = createTempPng();
      try {
        const result = await analyzeImageWithVision(
          {
            workspaceRoot: tmp.dir,
            visionAuxiliaryRoute: {
              task: "vision",
              route: baseRoute,
              source: "explicit",
              fallbackToMain: false,
              diagnostics: []
            },
            mainRoute,
            providerExecutor: executor
          },
          { path: "test.png" }
        );

        expect(executor.complete).toHaveBeenCalledTimes(1);
        expect(result.ok).toBe(false);
      } finally {
        tmp.cleanup();
      }
    });

    it("queues concurrent analysis for the same profile and route", async () => {
      const first = deferred<ProviderExecutionResult>();
      const second = deferred<ProviderExecutionResult>();
      const complete = vi.fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise);
      const executor = { complete } as unknown as ProviderExecutor;
      const tmp = createTempPng();
      const options = {
        workspaceRoot: tmp.dir,
        profileId: "profile-a",
        visionAuxiliaryRoute: {
          task: "vision" as const,
          route: baseRoute,
          source: "explicit" as const,
          fallbackToMain: false,
          maxConcurrency: 1,
          diagnostics: []
        },
        providerExecutor: executor
      };

      try {
        const firstRun = analyzeImageWithVision(options, { path: "test.png" });
        const secondRun = analyzeImageWithVision(options, { path: "test.png" });
        await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
        first.resolve(successfulExecution(baseRoute, "first"));
        await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));

        second.resolve(successfulExecution(baseRoute, "second"));
        await Promise.all([firstRun, secondRun]);
      } finally {
        tmp.cleanup();
      }
    });

    it("isolates vision concurrency across profiles", async () => {
      const first = deferred<ProviderExecutionResult>();
      const second = deferred<ProviderExecutionResult>();
      const complete = vi.fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise);
      const executor = { complete } as unknown as ProviderExecutor;
      const tmp = createTempPng();
      const auxiliaryRoute = {
        task: "vision" as const,
        route: baseRoute,
        source: "explicit" as const,
        fallbackToMain: false,
        maxConcurrency: 1,
        diagnostics: []
      };

      try {
        const profileA = analyzeImageWithVision({
          workspaceRoot: tmp.dir,
          profileId: "profile-a",
          visionAuxiliaryRoute: auxiliaryRoute,
          providerExecutor: executor
        }, { path: "test.png" });
        const profileB = analyzeImageWithVision({
          workspaceRoot: tmp.dir,
          profileId: "profile-b",
          visionAuxiliaryRoute: auxiliaryRoute,
          providerExecutor: executor
        }, { path: "test.png" });
        await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
        first.resolve(successfulExecution(baseRoute, "profile a"));
        second.resolve(successfulExecution(baseRoute, "profile b"));
        await Promise.all([profileA, profileB]);
      } finally {
        tmp.cleanup();
      }
    });

    it("isolates vision concurrency across routes in the same profile", async () => {
      const alternateRoute: ResolvedModelRoute = {
        ...baseRoute,
        id: "gpt-4o-mini",
        profile: { ...baseRoute.profile, id: "gpt-4o-mini" }
      };
      const first = deferred<ProviderExecutionResult>();
      const second = deferred<ProviderExecutionResult>();
      const complete = vi.fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise);
      const executor = { complete } as unknown as ProviderExecutor;
      const tmp = createTempPng();

      try {
        const firstRouteRun = analyzeImageWithVision({
          workspaceRoot: tmp.dir,
          profileId: "profile-a",
          visionAuxiliaryRoute: {
            task: "vision",
            route: baseRoute,
            source: "explicit",
            fallbackToMain: false,
            maxConcurrency: 1,
            diagnostics: []
          },
          providerExecutor: executor
        }, { path: "test.png" });
        const secondRouteRun = analyzeImageWithVision({
          workspaceRoot: tmp.dir,
          profileId: "profile-a",
          visionAuxiliaryRoute: {
            task: "vision",
            route: alternateRoute,
            source: "explicit",
            fallbackToMain: false,
            maxConcurrency: 1,
            diagnostics: []
          },
          providerExecutor: executor
        }, { path: "test.png" });
        await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
        first.resolve(successfulExecution(baseRoute, "first route"));
        second.resolve(successfulExecution(alternateRoute, "second route"));
        await Promise.all([firstRouteRun, secondRouteRun]);
      } finally {
        tmp.cleanup();
      }
    });
  });
});
