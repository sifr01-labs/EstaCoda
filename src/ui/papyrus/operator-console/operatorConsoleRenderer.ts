import type {
  OperatorConsoleLayout,
  OperatorConsoleRegion,
} from "./operatorConsoleLayout.js";
import type {
  OperatorConsoleState,
} from "./operatorConsoleState.js";
import { renderPromptSurface } from "./promptSurface.js";
import { renderStatusRailSurface } from "./statusRailSurface.js";

export type OperatorConsoleRenderedLine = {
  readonly region: OperatorConsoleRegion["kind"];
  readonly text: string;
};

export function renderOperatorConsoleLines(
  state: OperatorConsoleState,
  layout: OperatorConsoleLayout
): readonly OperatorConsoleRenderedLine[] {
  return layout.regions.flatMap((region) => renderRegionLines(state, region));
}

export function renderOperatorConsoleTextLines(
  state: OperatorConsoleState,
  layout: OperatorConsoleLayout
): readonly string[] {
  return renderOperatorConsoleLines(state, layout).map((line) => line.text);
}

function renderRegionLines(
  state: OperatorConsoleState,
  region: OperatorConsoleRegion
): readonly OperatorConsoleRenderedLine[] {
  if (!region.visible || region.height <= 0 || region.width <= 0) return [];
  if (region.kind === "prompt") {
    return renderPromptSurface(state.prompt, {
      width: region.width,
      height: region.height,
      terminalHeight: layoutHeightForRegion(region),
    }).map((text) => ({ region: region.kind, text }));
  }
  if (region.kind === "statusRail") {
    return [{ region: region.kind, text: renderStatusRailSurface(state.status, { width: region.width }) }];
  }
  const lines: OperatorConsoleRenderedLine[] = [];
  for (let row = 0; row < region.height; row += 1) {
    lines.push({
      region: region.kind,
      text: truncateLine(regionLabel(state, region, row), region.width),
    });
  }
  return lines;
}

function regionLabel(
  state: OperatorConsoleState,
  region: OperatorConsoleRegion,
  row: number
): string {
  if (row > 0) return `${region.kind}`;
  switch (region.kind) {
    case "transcript":
      return `Transcript: ${state.transcript.length} block${plural(state.transcript.length)}`;
    case "activeWork":
      return `Active work: ${state.activeWork.events.length} event${plural(state.activeWork.events.length)}`;
    case "queuedSteer":
      return `Queued steer: ${state.steer?.queued?.text ?? ""}`;
    case "attachments":
      return `Attachments: ${state.attachments.length}`;
    case "prompt":
      return `Prompt: ${state.prompt.value.length > 0 ? state.prompt.value : ">"}`;
    case "slashMenu":
      return `Slash menu: ${state.slash?.query ?? ""}`;
    case "statusRail":
      return renderStatusRailSurface(state.status, { width: region.width });
  }
}

function truncateLine(line: string, width: number): string {
  if (width <= 0) return "";
  if (line.length <= width) return line;
  return line.slice(0, width);
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
}

function layoutHeightForRegion(region: OperatorConsoleRegion): number {
  return region.y + region.height;
}
