import type { ResolvedAuxiliaryRoute, ResolvedModelRoute } from "../contracts/provider.js";
import type { VisionDispatchPhase } from "../contracts/vision.js";

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
  mainRoute?: ResolvedModelRoute;
  auxiliaryRoute: ResolvedAuxiliaryRoute;
}): VisionDispatchDecision {
  if (input.mainRoute?.profile.supportsVision === true) {
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
    reason: input.mainRoute === undefined
      ? "No main model route or vision auxiliary route is configured."
      : "The main model is text-only and no vision-capable auxiliary route is configured."
  };
}
