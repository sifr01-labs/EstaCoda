import type { Diff, Patch } from "./frame.js";

function isNoop(patch: Patch): boolean {
  if (patch.type === "noop") return true;
  if (patch.type === "stdout") return patch.content.length === 0;
  if (patch.type === "clear") return patch.count <= 0;
  if (patch.type === "cursorMove") return patch.x === 0 && patch.y === 0;
  return false;
}

export function optimize(diff: Diff): Diff {
  const result: Diff = [];

  for (const patch of diff) {
    if (isNoop(patch)) continue;

    const last = result[result.length - 1];
    if (last?.type === "stdout" && patch.type === "stdout") {
      result[result.length - 1] = { type: "stdout", content: last.content + patch.content };
      continue;
    }

    if (last?.type === "cellRun" && patch.type === "cellRun" && last.y === patch.y && last.x + last.content.length === patch.x && JSON.stringify(last.style) === JSON.stringify(patch.style) && last.hyperlink === patch.hyperlink) {
      result[result.length - 1] = { ...last, content: last.content + patch.content };
      continue;
    }

    if (last?.type === "cursorMove" && patch.type === "cursorMove") {
      result[result.length - 1] = { type: "cursorMove", x: last.x + patch.x, y: last.y + patch.y };
      continue;
    }

    if (last?.type === "cursorTo" && patch.type === "cursorTo") {
      result[result.length - 1] = patch;
      continue;
    }

    result.push(patch);
  }

  return result;
}
