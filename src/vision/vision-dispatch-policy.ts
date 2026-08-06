import type { ResolvedAuxiliaryRoute, ResolvedModelRoute } from "../contracts/provider.js";
import type { VisionAnalysisMode, VisionDispatchPhase } from "../contracts/vision.js";

export type { VisionDispatchPhase } from "../contracts/vision.js";

export type VisionDispatchDecision =
  | {
      mode: "native";
      phase: VisionDispatchPhase;
      route: ResolvedModelRoute;
      egressRoute: ResolvedAuxiliaryRoute;
    }
  | {
      mode: "auxiliary";
      phase: VisionDispatchPhase;
      route: ResolvedModelRoute;
      auxiliaryRoute: ResolvedAuxiliaryRoute;
      egressRoute: ResolvedAuxiliaryRoute;
    }
  | {
      mode: "unavailable";
      phase: VisionDispatchPhase;
      reason: string;
    };

export function resolveVisionDispatch(input: {
  phase: VisionDispatchPhase;
  analysisMode?: VisionAnalysisMode;
  mainRoute?: ResolvedModelRoute;
  auxiliaryRoute: ResolvedAuxiliaryRoute;
}): VisionDispatchDecision {
  const dedicatedAnalysis = shouldUseDedicatedVisionRoute(input);
  if (input.mainRoute?.profile.supportsVision === true && !dedicatedAnalysis) {
    const nativeRoute: ResolvedAuxiliaryRoute = {
      task: "vision",
      route: input.mainRoute,
      source: "main",
      fallbackToMain: false,
      diagnostics: []
    };
    return {
      mode: "native",
      phase: input.phase,
      route: input.mainRoute,
      egressRoute: nativeRoute
    };
  }

  if (input.auxiliaryRoute.route?.profile.supportsVision === true) {
    return {
      mode: "auxiliary",
      phase: input.phase,
      route: input.auxiliaryRoute.route,
      auxiliaryRoute: input.auxiliaryRoute,
      egressRoute: input.auxiliaryRoute
    };
  }

  return {
    mode: "unavailable",
    phase: input.phase,
    reason: dedicatedAnalysis
      ? "The configured dedicated vision route is unavailable for this specialized analysis."
      : input.mainRoute === undefined
        ? "No main model route or vision auxiliary route is configured."
        : "The main model is text-only and no vision-capable auxiliary route is configured."
  };
}

function shouldUseDedicatedVisionRoute(input: {
  phase: VisionDispatchPhase;
  analysisMode?: VisionAnalysisMode;
  auxiliaryRoute: ResolvedAuxiliaryRoute;
}): boolean {
  if (input.phase === "initial-attachment") return false;
  if (input.analysisMode === undefined || input.analysisMode === "describe") return false;
  return input.auxiliaryRoute.source === "explicit" || input.auxiliaryRoute.source === "custom";
}
