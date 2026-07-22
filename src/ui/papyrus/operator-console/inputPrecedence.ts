import type { ParsedKeypress } from "../../input/parseKeypress.js";
import { createOperatorConsoleHitRegions, findOperatorConsoleHitRegion } from "./operatorConsoleHitRegions.js";
import { createOperatorConsoleLayout, type OperatorConsoleLayout } from "./operatorConsoleLayout.js";
import type { OperatorConsoleState } from "./operatorConsoleState.js";
import { routeTaskSurfaceKey, routeTaskSurfacePointer } from "./taskSurface.js";

export type OperatorConsoleInputSurface =
  | "taskInspection"
  | "approval"
  | "typeahead"
  | "attachment"
  | "liveFocus"
  | "steer"
  | "prompt";

/** One canonical precedence chain for interactive session input. */
export function resolveOperatorConsoleInputSurface(input: {
  readonly taskInspection: boolean;
  readonly approval: boolean;
  readonly typeahead: boolean;
  readonly attachment: boolean;
  readonly liveFocus?: boolean;
  readonly steer?: boolean;
}): OperatorConsoleInputSurface {
  if (input.taskInspection) return "taskInspection";
  if (input.approval) return "approval";
  if (input.typeahead) return "typeahead";
  if (input.attachment) return "attachment";
  if (input.liveFocus === true) return "liveFocus";
  if (input.steer === true) return "steer";
  return "prompt";
}

export type OperatorConsoleInputRouteResult = {
  readonly state: OperatorConsoleState;
  readonly surface: OperatorConsoleInputSurface;
  readonly handled: boolean;
};

/** Shared Task-aware input router used by idle prompts and active-turn steering. */
export function routeOperatorConsoleInput(input: {
  readonly state: OperatorConsoleState;
  readonly event: ParsedKeypress;
  readonly approval: boolean;
  readonly typeahead: boolean;
  readonly attachment: boolean;
  readonly steer: boolean;
  readonly layout?: OperatorConsoleLayout;
}): OperatorConsoleInputRouteResult {
  const inspectionOpen = input.state.tasks.inspectedTaskId !== undefined;
  const liveFocus = input.state.focus.target.kind === "taskCard" || input.state.focus.target.kind === "taskSubagent";
  const surface = resolveOperatorConsoleInputSurface({
    taskInspection: inspectionOpen,
    approval: input.approval,
    typeahead: input.typeahead,
    attachment: input.attachment,
    liveFocus,
    steer: input.steer,
  });
  if (input.event.type === "mouse") {
    if (surface === "approval" || surface === "typeahead" || surface === "attachment") {
      return { state: input.state, surface, handled: true };
    }
    const layout = input.layout ?? createOperatorConsoleLayout(input.state);
    if (input.event.action === "scroll") {
      const inspection = layout.regions.find((region) => region.kind === "taskInspection" && region.visible);
      if (inspection !== undefined && pointInside(input.event.x, input.event.y, inspection)) {
        return {
          state: routeTaskSurfacePointer(input.state, {
            type: "scroll",
            delta: input.event.button === "wheelUp" ? -3 : 3,
          }, inspection.height),
          surface: "taskInspection",
          handled: true,
        };
      }
      return { state: input.state, surface, handled: true };
    }
    if (input.event.action !== "press" || input.event.button !== "primary") {
      return { state: input.state, surface, handled: true };
    }
    const hit = findOperatorConsoleHitRegion(
      createOperatorConsoleHitRegions(input.state, layout),
      input.event.x,
      input.event.y
    );
    if (hit === undefined) return { state: input.state, surface, handled: true };
    return {
      state: routeTaskSurfacePointer(input.state, hit.action, layout.height),
      surface: inspectionOpen ? "taskInspection" : "liveFocus",
      handled: true,
    };
  }
  if (inspectionOpen) {
    if (input.event.type !== "key") return { state: input.state, surface: "taskInspection", handled: true };
    const layout = input.layout ?? createOperatorConsoleLayout(input.state);
    const viewportHeight = layout.regions.find((region) => region.kind === "taskInspection")?.height;
    const routed = routeTaskSurfaceKey(input.state, input.event, viewportHeight ?? input.state.terminal.height);
    return { state: routed.state, surface: "taskInspection", handled: routed.handled };
  }
  if (surface === "approval" || surface === "typeahead" || surface === "attachment") {
    return { state: input.state, surface, handled: false };
  }
  if (input.state.tasks.cards.length > 0) {
    const layout = input.layout ?? createOperatorConsoleLayout(input.state);
    const viewportHeight = layout.regions.find((region) => region.kind === "taskCards")?.height;
    const routed = routeTaskSurfaceKey(input.state, input.event, viewportHeight ?? input.state.terminal.height);
    if (routed.handled) return { state: routed.state, surface: "liveFocus", handled: true };
  }
  return { state: input.state, surface, handled: false };
}

function pointInside(
  x: number,
  y: number,
  region: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
): boolean {
  return x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height;
}
