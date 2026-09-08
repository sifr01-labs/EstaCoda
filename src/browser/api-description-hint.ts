import type { BrowserSnapshot } from "../contracts/browser.js";
import { isBrowserSnapshotElementInteractable } from "./browser-interactability.js";
import { isActionableBrowserRole } from "./snapshot-state.js";

const API_DESCRIPTION_PATTERN = /\b(?:open\s*api|swagger|async\s*api|raml|graphql|proto(?:buf)?|smithy)\b/iu;
const EXPORT_PATTERN = /\b(?:download|export)\b/iu;

/** Returns one soft hint from a current, grounded, actionable browser element. */
export function machineReadableApiDescriptionHint(snapshot: BrowserSnapshot): string | undefined {
  const candidate = (snapshot.elements ?? []).find((element) => {
    if (!isBrowserSnapshotElementInteractable(element) || !isActionableBrowserRole(element.role)) return false;
    const description = [element.name, element.label, element.text]
      .filter((value): value is string => typeof value === "string")
      .join(" ");
    return API_DESCRIPTION_PATTERN.test(description) && EXPORT_PATTERN.test(description);
  });
  if (candidate === undefined) return undefined;
  const label = candidate.name ?? candidate.label ?? candidate.text ?? "API description download";
  return `Machine-readable API description available: ${candidate.ref} ${label.slice(0, 160)}`;
}
