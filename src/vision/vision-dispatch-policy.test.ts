import { describe, expect, it } from "vitest";
import type { ResolvedAuxiliaryRoute, ResolvedModelRoute } from "../contracts/provider.js";
import { resolveVisionDispatch } from "./vision-dispatch-policy.js";

describe("vision dispatch policy", () => {
  it("keeps an explicitly disabled vision slot off even when the main model supports vision", () => {
    expect(resolveVisionDispatch({
      phase: "initial-attachment",
      mainRoute: route("main-vision", true),
      auxiliaryRoute: {
        ...auxiliary(undefined),
        source: "disabled"
      }
    })).toEqual({
      mode: "unavailable",
      phase: "initial-attachment",
      reason: "Vision Analysis is turned off in the selected profile."
    });
  });

  it("uses the main route for initial and discovered images when it supports vision", () => {
    for (const phase of ["initial-attachment", "post-tool"] as const) {
      expect(resolveVisionDispatch({
        phase,
        mainRoute: route("main", true),
        auxiliaryRoute: auxiliary(route("aux", true))
      })).toMatchObject({ mode: "native", phase, route: { id: "main" } });
    }
  });

  it("uses the auxiliary route when the main route is text-only", () => {
    expect(resolveVisionDispatch({
      phase: "initial-attachment",
      mainRoute: route("main-text", false),
      auxiliaryRoute: auxiliary(route("aux-vision", true))
    })).toMatchObject({ mode: "auxiliary", route: { id: "aux-vision" } });
  });

  it("uses an explicitly dedicated route for specialized post-tool analysis", () => {
    for (const analysisMode of ["ocr", "document", "chart", "screenshot"] as const) {
      expect(resolveVisionDispatch({
        phase: "post-tool",
        analysisMode,
        mainRoute: route("main-vision", true),
        auxiliaryRoute: auxiliary(route("specialized-vision", true))
      })).toMatchObject({ mode: "auxiliary", route: { id: "specialized-vision" } });
    }
  });

  it("keeps describe, initial attachments, and automatic routes native", () => {
    expect(resolveVisionDispatch({
      phase: "post-tool",
      analysisMode: "describe",
      mainRoute: route("main-vision", true),
      auxiliaryRoute: auxiliary(route("specialized-vision", true))
    })).toMatchObject({ mode: "native", route: { id: "main-vision" } });

    expect(resolveVisionDispatch({
      phase: "initial-attachment",
      analysisMode: "ocr",
      mainRoute: route("main-vision", true),
      auxiliaryRoute: auxiliary(route("specialized-vision", true))
    })).toMatchObject({ mode: "native", route: { id: "main-vision" } });

    expect(resolveVisionDispatch({
      phase: "post-tool",
      analysisMode: "ocr",
      mainRoute: route("main-vision", true),
      auxiliaryRoute: auxiliary(route("automatic-vision", true), "auto-configured")
    })).toMatchObject({ mode: "native", route: { id: "main-vision" } });
  });

  it("fails specialized analysis when its configured dedicated route is unavailable", () => {
    expect(resolveVisionDispatch({
      phase: "post-tool",
      analysisMode: "ocr",
      mainRoute: route("main-vision", true),
      auxiliaryRoute: auxiliary(undefined)
    })).toEqual({
      mode: "unavailable",
      phase: "post-tool",
      reason: "The configured dedicated vision route is unavailable for this specialized analysis."
    });
  });

  it("fails clearly instead of sending images to a text-only fallback", () => {
    expect(resolveVisionDispatch({
      phase: "post-tool",
      mainRoute: route("main-text", false),
      auxiliaryRoute: auxiliary(undefined)
    })).toEqual({
      mode: "unavailable",
      phase: "post-tool",
      reason: "The main model is text-only and no vision-capable auxiliary route is configured."
    });
  });

  it("routes comparison only through multi-image-capable routes", () => {
    const singleImageMain = route("single-main", true);
    singleImageMain.profile.supportsMultipleImages = false;
    expect(resolveVisionDispatch({
      phase: "post-tool",
      analysisMode: "compare",
      imageCount: 2,
      mainRoute: singleImageMain,
      auxiliaryRoute: auxiliary(multiImageRoute("multi-aux"), "auto-configured")
    })).toMatchObject({ mode: "auxiliary", route: { id: "multi-aux" } });

    const singleImageAux = route("single-aux", true);
    singleImageAux.profile.supportsMultipleImages = false;
    expect(resolveVisionDispatch({
      phase: "post-tool",
      analysisMode: "compare",
      imageCount: 2,
      mainRoute: singleImageMain,
      auxiliaryRoute: auxiliary(singleImageAux, "auto-configured")
    })).toEqual({
      mode: "unavailable",
      phase: "post-tool",
      reason: "No configured vision route supports bounded multi-image comparison."
    });
  });

  it("does not assume unknown custom routes support multiple images", () => {
    expect(resolveVisionDispatch({
      phase: "post-tool",
      analysisMode: "compare",
      imageCount: 2,
      auxiliaryRoute: auxiliary(route("unknown-custom", true), "custom")
    })).toMatchObject({
      mode: "unavailable",
      reason: "No configured vision route supports bounded multi-image comparison."
    });
  });

  it("allows a caller to handle an unknown custom multi-image request through safe batching", () => {
    expect(resolveVisionDispatch({
      phase: "post-tool",
      analysisMode: "compare",
      imageCount: 2,
      allowBatching: true,
      auxiliaryRoute: auxiliary(route("unknown-custom", true), "custom")
    })).toMatchObject({ mode: "auxiliary" });
  });

  it("removes an incompatible main fallback from auxiliary comparison", () => {
    const main = route("single-main", true);
    main.profile.supportsMultipleImages = false;
    const result = resolveVisionDispatch({
      phase: "post-tool",
      analysisMode: "compare",
      imageCount: 2,
      mainRoute: main,
      auxiliaryRoute: { ...auxiliary(multiImageRoute("multi-aux")), fallbackToMain: true }
    });
    expect(result).toMatchObject({ mode: "auxiliary", auxiliaryRoute: { fallbackToMain: false } });
  });
});

function route(id: string, supportsVision: boolean): ResolvedModelRoute {
  return {
    provider: "test-provider",
    id,
    profile: {
      id,
      provider: "test-provider",
      contextWindowTokens: 32_000,
      supportsTools: true,
      supportsVision,
      supportsStructuredOutput: true
    }
  };
}

function multiImageRoute(id: string): ResolvedModelRoute {
  const modelRoute = route(id, true);
  modelRoute.profile.supportsMultipleImages = true;
  return modelRoute;
}

function auxiliary(
  modelRoute: ResolvedModelRoute | undefined,
  source: ResolvedAuxiliaryRoute["source"] = "explicit"
): ResolvedAuxiliaryRoute {
  return {
    task: "vision",
    route: modelRoute,
    source,
    fallbackToMain: false,
    diagnostics: []
  };
}
