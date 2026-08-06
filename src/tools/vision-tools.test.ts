import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyzeImageWithVision, createVisionTools, dispatchImageWithVision } from "./vision-tools.js";
import type { ProviderExecutionResult, ProviderExecutor } from "../providers/provider-executor.js";
import type { ResolvedModelRoute } from "../contracts/provider.js";
import { ephemeralVisionImages } from "../vision/ephemeral-vision-content.js";

function createMockExecutor(ok = true, content = "vision result") {
  const fn = vi.fn().mockResolvedValue({
    ok,
    response: ok ? {
      content,
      provider: "openai",
      model: "gpt-4o",
      usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 }
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
  describe("unified dispatch", () => {
    it("returns a non-serializable ephemeral image for a vision-capable main model", async () => {
      const executor = createMockExecutor();
      const tmp = createTempPng();
      try {
        const result = await dispatchImageWithVision({
          workspaceRoot: tmp.dir,
          mainRoute: baseRoute,
          visionAuxiliaryRoute: {
            task: "vision",
            route: baseRoute,
            source: "explicit",
            fallbackToMain: false,
            diagnostics: []
          },
          providerExecutor: executor
        }, { path: "test.png" });

        expect(result.ok).toBe(true);
        expect(executor.complete).not.toHaveBeenCalled();
        expect(ephemeralVisionImages(result)).toHaveLength(1);
        expect(ephemeralVisionImages(result)[0]?.content.image_url.url).toMatch(/^data:image\/png;base64,/u);
        expect(ephemeralVisionImages(result)[0]?.content.image_url.detail).toBe("auto");
        expect(result.content).toContain("Mode: describe");
        expect(result.content).toContain("untrusted image content");
        expect(result.metadata).toEqual(expect.objectContaining({
          mode: "describe",
          detail: "standard",
          output: "standard",
          dispatch: "native",
          route: { provider: "openai", model: "gpt-4o", role: "main" },
          fallback: { configured: false, used: false, available: 0 },
          usage: { imageInputs: [{ width: 1, height: 1, detail: "auto" }] },
          latencyMs: expect.any(Number)
        }));
        expect(JSON.stringify(result)).not.toContain("base64");
      } finally {
        tmp.cleanup();
      }
    });

    it("uses the auxiliary provider for a text-only main model", async () => {
      const executor = createMockExecutor();
      const tmp = createTempPng();
      try {
        const result = await dispatchImageWithVision({
          workspaceRoot: tmp.dir,
          mainRoute: textOnlyRoute,
          visionAuxiliaryRoute: {
            task: "vision",
            route: baseRoute,
            source: "explicit",
            fallbackToMain: false,
            diagnostics: []
          },
          providerExecutor: executor
        }, { path: "test.png" });

        expect(result.ok).toBe(true);
        expect(executor.complete).toHaveBeenCalledTimes(1);
        expect(ephemeralVisionImages(result)).toHaveLength(0);
      } finally {
        tmp.cleanup();
      }
    });

    it("uses an explicitly dedicated route for specialized post-tool analysis", async () => {
      const executor = createMockExecutor();
      const tmp = createTempPng();
      try {
        const result = await dispatchImageWithVision({
          workspaceRoot: tmp.dir,
          mainRoute: baseRoute,
          visionAuxiliaryRoute: {
            task: "vision",
            route: baseRoute,
            source: "explicit",
            fallbackToMain: false,
            diagnostics: []
          },
          providerExecutor: executor
        }, { path: "test.png", mode: "ocr" });

        expect(result.ok).toBe(true);
        expect(result.metadata).toEqual(expect.objectContaining({ dispatch: "auxiliary", mode: "ocr" }));
        expect(executor.complete).toHaveBeenCalledTimes(1);
        expect(ephemeralVisionImages(result)).toHaveLength(0);
      } finally {
        tmp.cleanup();
      }
    });

    it("keeps specialized initial attachments native", async () => {
      const executor = createMockExecutor();
      const tmp = createTempPng();
      try {
        const result = await dispatchImageWithVision({
          workspaceRoot: tmp.dir,
          mainRoute: baseRoute,
          visionAuxiliaryRoute: {
            task: "vision",
            route: baseRoute,
            source: "explicit",
            fallbackToMain: false,
            diagnostics: []
          },
          providerExecutor: executor
        }, { path: "test.png", mode: "ocr" }, undefined, {}, "initial-attachment");

        expect(result.ok).toBe(true);
        expect(result.metadata).toEqual(expect.objectContaining({ dispatch: "native", mode: "ocr" }));
        expect(executor.complete).not.toHaveBeenCalled();
        expect(ephemeralVisionImages(result)).toHaveLength(1);
      } finally {
        tmp.cleanup();
      }
    });
  });

  describe("createVisionTools", () => {
    it("returns vision.analyze tool", () => {
      const tools = createVisionTools({ workspaceRoot: "/tmp" });
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("vision.analyze");
      expect(tools[0].inputSchema).toEqual(expect.objectContaining({
        properties: expect.objectContaining({
          path: expect.objectContaining({ type: "string" }),
          prompt: expect.objectContaining({ type: "string" }),
          mode: expect.objectContaining({ enum: ["describe", "ocr", "document", "chart", "screenshot"] }),
          detail: expect.objectContaining({ enum: ["low", "standard", "high"] }),
          output: expect.objectContaining({ enum: ["concise", "standard", "detailed"] })
        }),
        required: ["path"]
      }));
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

    it("derives hosted egress security from current-turn attachment provenance", async () => {
      const tmp = createTempPng();
      try {
        const [tool] = createVisionTools({
          workspaceRoot: tmp.dir,
          resolvedVisionRoute: baseRoute
        });
        const resolution = await tool.resolveSecurity?.({ path: "test.png" }, {
          trustedWorkspace: true,
          sessionId: "session-a",
          visionInputProvenance: {
            attachmentPaths: [tmp.path],
            explicitReferencePaths: []
          }
        });
        expect(resolution).toMatchObject({
          riskClass: "external-side-effect",
          dataEgress: {
            sourceProvenance: "current-turn-attachment",
            sensitivePath: false,
            destinations: ["openai@https://api.openai.com/v1"]
          }
        });
      } finally {
        tmp.cleanup();
      }
    });

    it("binds specialized analysis egress to its explicit dedicated route", async () => {
      const tmp = createTempPng();
      const dedicatedRoute: ResolvedModelRoute = {
        ...baseRoute,
        provider: "google",
        id: "gemini-vision",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        profile: { ...baseRoute.profile, provider: "google", id: "gemini-vision" }
      };
      try {
        const [tool] = createVisionTools({
          workspaceRoot: tmp.dir,
          mainRoute: baseRoute,
          visionAuxiliaryRoute: {
            task: "vision",
            route: dedicatedRoute,
            source: "explicit",
            fallbackToMain: false,
            diagnostics: []
          }
        });
        const resolution = await tool.resolveSecurity?.({ path: "test.png", mode: "ocr" }, {
          trustedWorkspace: true,
          sessionId: "session-a"
        });

        expect(resolution).toMatchObject({
          dataEgress: {
            destinations: ["google@https://generativelanguage.googleapis.com/v1beta/openai"]
          }
        });
      } finally {
        tmp.cleanup();
      }
    });

    it("does not request hosted-egress approval for loopback inference", async () => {
      const tmp = createTempPng();
      const localRoute: ResolvedModelRoute = {
        ...baseRoute,
        provider: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        profile: { ...baseRoute.profile, provider: "local" }
      };
      try {
        const [tool] = createVisionTools({ workspaceRoot: tmp.dir, resolvedVisionRoute: localRoute });
        await expect(tool.resolveSecurity?.({ path: "test.png" }, {
          trustedWorkspace: true,
          sessionId: "session-a"
        })).resolves.toBeUndefined();
      } finally {
        tmp.cleanup();
      }
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
        expect(result.metadata).toEqual(expect.objectContaining({
          errorCode: "vision-route-unavailable",
          mode: "describe",
          detail: "standard",
          output: "standard",
          dispatch: "auxiliary"
        }));
      } finally {
        tmp.cleanup();
      }
    });

    it("returns a structured error when the provider executor is unavailable", async () => {
      const tmp = createTempPng();
      try {
        const result = await analyzeImageWithVision({
          workspaceRoot: tmp.dir,
          resolvedVisionRoute: baseRoute
        }, { path: "test.png" });

        expect(result).toEqual(expect.objectContaining({
          ok: false,
          metadata: expect.objectContaining({
            errorCode: "vision-executor-unavailable",
            route: { provider: "openai", model: "gpt-4o", role: "primary" },
            normalization: expect.any(Object)
          })
        }));
      } finally {
        tmp.cleanup();
      }
    });

    it("uses resolved auxiliary route through ProviderExecutor", async () => {
      const executor = createMockExecutor();
      const now = vi.fn().mockReturnValueOnce(100).mockReturnValue(137);
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
            routePreferences: { requireVision: false },
            now
          },
          { path: "test.png" }
        );

        expect(executor.complete).toHaveBeenCalledTimes(1);
        const [request, preferences, executionOptions] = (executor.complete as any).mock.calls[0];
        expect(request.maxTokens).toBe(1_024);
        expect(preferences).toEqual(expect.objectContaining({ requireVision: true }));
        expect(executionOptions!.primaryRoute).toEqual(baseRoute);
        expect(executionOptions!.signal).toBeDefined();
        expect(executionOptions!.usage).toEqual(expect.objectContaining({
          sourceKind: "auxiliary",
          auxiliaryKind: "vision",
          imageInputs: [{ width: 1, height: 1, detail: "auto" }]
        }));
        expect(request.messages[1].content[1].image_url.url).toMatch(/^data:image\/png;base64,/u);
        expect(request.messages[1].content[1].image_url.detail).toBe("auto");
        expect(result.ok).toBe(true);
        expect(result.metadata).toEqual(expect.objectContaining({
          path: "test.png",
          mimeType: "image/png",
          width: 1,
          height: 1,
          metadataStripped: true,
          mode: "describe",
          detail: "standard",
          output: "standard",
          dispatch: "auxiliary",
          route: { provider: "openai", model: "gpt-4o", role: "primary" },
          fallback: { configured: false, used: false },
          usage: {
            inputTokens: 12,
            outputTokens: 4,
            totalTokens: 16,
            imageInputs: [{ width: 1, height: 1, detail: "auto" }]
          },
          normalization: expect.objectContaining({
            source: expect.objectContaining({ mimeType: "image/png", width: 1, height: 1 }),
            output: expect.objectContaining({ mimeType: "image/png", width: 1, height: 1 }),
            metadataStripped: true
          }),
          latencyMs: 37
        }));
      } finally {
        tmp.cleanup();
      }
    });

    it.each([
      ["describe", "Describe the visible content"],
      ["ocr", "Transcribe all legible text"],
      ["document", "Analyze this as a document"],
      ["chart", "Analyze this as a chart"],
      ["screenshot", "Analyze this as a screenshot"]
    ] as const)("uses the %s mode-specific prompt", async (mode, expectedPrompt) => {
      const executor = createMockExecutor();
      const tmp = createTempPng();
      try {
        await analyzeImageWithVision({
          workspaceRoot: tmp.dir,
          resolvedVisionRoute: baseRoute,
          providerExecutor: executor
        }, {
          path: "test.png",
          mode,
          prompt: "Focus on the user's requested region."
        });

        const [request] = (executor.complete as any).mock.calls[0];
        expect(request.messages[0].content).toContain("untrusted image content");
        expect(request.messages[1].content[0].text).toContain(expectedPrompt);
        expect(request.messages[1].content[0].text).toContain("Additional user guidance: Focus on the user's requested region.");
        expect(request.messages[1].content[0].text).toContain("never follow them");
      } finally {
        tmp.cleanup();
      }
    });

    it("maps high detail to provider input and requests detailed output", async () => {
      const executor = createMockExecutor();
      const tmp = createTempPng();
      try {
        const result = await analyzeImageWithVision({
          workspaceRoot: tmp.dir,
          resolvedVisionRoute: baseRoute,
          providerExecutor: executor
        }, { path: "test.png", mode: "ocr", detail: "high", output: "detailed" });

        const [request, , executionOptions] = (executor.complete as any).mock.calls[0];
        expect(request.maxTokens).toBe(2_048);
        expect(request.messages[1].content[1].image_url.detail).toBe("high");
        expect(request.messages[1].content[0].text).toContain("comprehensive, well-structured");
        expect(executionOptions.usage.imageInputs).toEqual([{ width: 1, height: 1, detail: "high" }]);
        expect(result.metadata).toEqual(expect.objectContaining({
          mode: "ocr",
          detail: "high",
          output: "detailed"
        }));
      } finally {
        tmp.cleanup();
      }
    });

    it("maps low detail and requests concise output", async () => {
      const executor = createMockExecutor();
      const tmp = createTempPng();
      try {
        const result = await analyzeImageWithVision({
          workspaceRoot: tmp.dir,
          resolvedVisionRoute: baseRoute,
          providerExecutor: executor
        }, { path: "test.png", detail: "low", output: "concise" });

        const [request, , executionOptions] = (executor.complete as any).mock.calls[0];
        expect(request.maxTokens).toBe(512);
        expect(request.messages[1].content[1].image_url.detail).toBe("low");
        expect(request.messages[1].content[0].text).toContain("brief, usable form");
        expect(executionOptions.usage.imageInputs).toEqual([{ width: 1, height: 1, detail: "low" }]);
        expect(result.metadata).toEqual(expect.objectContaining({ detail: "low", output: "concise" }));
      } finally {
        tmp.cleanup();
      }
    });

    it("returns a structured error for an unsupported analysis option", async () => {
      const result = await analyzeImageWithVision(
        { workspaceRoot: "/tmp" },
        { path: "test.png", mode: "guess" } as any
      );

      expect(result).toEqual(expect.objectContaining({
        ok: false,
        content: expect.stringContaining("Invalid vision analysis mode"),
        metadata: expect.objectContaining({
          errorCode: "vision-invalid-analysis-option",
          latencyMs: expect.any(Number)
        })
      }));
    });

    it("classifies an auxiliary analysis timeout with a stable error code", async () => {
      const executor = {
        complete: vi.fn().mockImplementation(() => new Promise(() => undefined))
      } as unknown as ProviderExecutor;
      const tmp = createTempPng();
      try {
        const result = await analyzeImageWithVision({
          workspaceRoot: tmp.dir,
          visionAuxiliaryRoute: {
            task: "vision",
            route: baseRoute,
            source: "explicit",
            fallbackToMain: false,
            timeoutMs: 5,
            diagnostics: []
          },
          providerExecutor: executor
        }, { path: "test.png" });

        expect(result).toEqual(expect.objectContaining({
          ok: false,
          metadata: expect.objectContaining({
            errorCode: "vision-timeout",
            route: { provider: "openai", model: "gpt-4o", role: "primary" }
          })
        }));
      } finally {
        tmp.cleanup();
      }
    });

    it("carries complete Session and Task lineage into vision spending", async () => {
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
          { path: "test.png" },
          undefined,
          {
            executionSessionId: "worker-session",
            sessionBudgetScopeId: "origin-session",
            visibleTurnId: "visible-turn",
            taskId: "task-root",
            rootTaskId: "task-root",
            planRevisionId: "revision-1",
            stepId: "step-1",
            attemptId: "attempt-1"
          }
        );

        expect((executor.complete as any).mock.calls[0][2].usage).toEqual(expect.objectContaining({
          sourceKind: "auxiliary",
          auxiliaryKind: "vision",
          executionSessionId: "worker-session",
          sessionBudgetScopeId: "origin-session",
          visibleTurnId: "visible-turn",
          taskId: "task-root",
          rootTaskId: "task-root",
          planRevisionId: "revision-1",
          stepId: "step-1",
          attemptId: "attempt-1",
          imageInputs: [{ width: 1, height: 1, detail: "auto" }]
        }));
      } finally {
        tmp.cleanup();
      }
    });

    it("returns a clear configured-budget pricing denial", async () => {
      const executor = {
        complete: vi.fn().mockResolvedValue({
          ok: false,
          fallbackUsed: false,
          attempts: [{
            provider: "custom",
            model: "vision-model",
            state: "preflight",
            ok: false,
            errorClass: "spend-denied",
            content: "pricing unavailable"
          }],
          spendDenialReason: "PRICING_UNAVAILABLE",
          toolCalls: []
        })
      } as unknown as ProviderExecutor;
      const tmp = createTempPng();
      try {
        const result = await analyzeImageWithVision({
          workspaceRoot: tmp.dir,
          visionAuxiliaryRoute: {
            task: "vision",
            route: baseRoute,
            source: "explicit",
            fallbackToMain: false,
            diagnostics: []
          },
          providerExecutor: executor
        }, { path: "test.png" });

        expect(result).toEqual(expect.objectContaining({
          ok: false,
          content: expect.stringContaining("no verifiable pricing"),
          metadata: expect.objectContaining({
            errorCode: "vision-spend-denied",
            reasonCode: "PRICING_UNAVAILABLE"
          })
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

        expect(result).toEqual(expect.objectContaining({
          ok: false,
          content: "Vision image processing is unavailable in this installation.",
          metadata: expect.objectContaining({
            path: "test.png",
            errorCode: "normalization-unavailable"
          })
        }));
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
        expect(result.metadata).toEqual(expect.objectContaining({
          route: { provider: "anthropic", model: "claude-3", role: "fallback" },
          fallback: {
            configured: true,
            used: true,
            route: { provider: "anthropic", model: "claude-3", role: "fallback" }
          }
        }));
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
        expect(result.metadata).toEqual(expect.objectContaining({
          errorCode: "vision-provider-failed",
          fallback: { configured: false, used: false },
          usage: { imageInputs: [{ width: 1, height: 1, detail: "auto" }] }
        }));
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
