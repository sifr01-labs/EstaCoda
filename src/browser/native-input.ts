import {
  assertBrowserRuntimeEvaluationSucceeded,
  browserInteractabilityGuardSource
} from "./browser-interactability.js";

type NativeInputClient = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
};

export class NativeBrowserInputDispatchError extends Error {
  readonly actionDispatched: boolean;

  constructor(message: string, actionDispatched: boolean, cause: unknown) {
    super(message, { cause });
    this.name = "NativeBrowserInputDispatchError";
    this.actionDispatched = actionDispatched;
  }
}

/**
 * Resolves geometry in the page, then dispatches trusted CDP pointer input.
 * Page script is used only for bounded observation and scrolling; it never
 * invokes click(), changes popup permissions, or synthesizes DOM events.
 */
export async function dispatchNativeBrowserClick(
  client: NativeInputClient,
  ref: string
): Promise<void> {
  const target = refTarget(ref);
  const guard = browserInteractabilityGuardSource(target.expression, ref);
  const evaluation = await client.send("Runtime.evaluate", {
    expression: `(() => {
      ${guard}
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const rect = el.getBoundingClientRect();
      const actionSelector = 'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"]';
      const insetX = Math.min(16, rect.width / 4);
      const insetY = Math.min(16, rect.height / 4);
      const points = ${target.kind === "region" ? `[
        { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
        { x: rect.left + insetX, y: rect.top + insetY },
        { x: rect.right - insetX, y: rect.top + insetY },
        { x: rect.left + insetX, y: rect.bottom - insetY },
        { x: rect.right - insetX, y: rect.bottom - insetY }
      ]` : `[{ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }]`};
      const point = points.find(({ x, y }) => {
        const hit = document.elementFromPoint(x, y);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !(hit === el || (hit instanceof Node && el.contains(hit)))) return false;
        if (${JSON.stringify(target.kind)} !== 'region') return true;
        const nestedAction = hit instanceof Element ? hit.closest(actionSelector) : null;
        return nestedAction === null || nestedAction === el || !el.contains(nestedAction);
      });
      if (point === undefined || rect.width <= 0 || rect.height <= 0) {
        throw new Error('Browser target is not pointer-interactable: ${ref}');
      }
      return point;
    })()`,
    returnByValue: true
  });
  assertBrowserRuntimeEvaluationSucceeded(evaluation);
  const point = runtimeEvaluationRecord(evaluation);
  if (typeof point?.x !== "number" || !Number.isFinite(point.x) ||
      typeof point.y !== "number" || !Number.isFinite(point.y)) {
    throw new Error(`Browser target geometry could not be resolved safely: ${ref}`);
  }

  let pressAttempted = false;
  try {
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    pressAttempted = true;
    await client.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 1,
      clickCount: 1
    });
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 0,
      clickCount: 1
    });
  } catch (error) {
    if (pressAttempted) {
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button: "left",
        buttons: 0,
        clickCount: 1
      }).catch(() => undefined);
    }
    throw new NativeBrowserInputDispatchError(
      pressAttempted
        ? `Native browser click may have been partially dispatched: ${ref}`
        : `Native browser click was not dispatched: ${ref}`,
      pressAttempted,
      error
    );
  }
}

function refTarget(ref: string): { kind: "element" | "region"; expression: string } {
  const match = /^@?([er])(\d+)$/u.exec(ref);
  if (match === null) throw new Error(`Invalid browser target ref: ${ref}`);
  const index = Number(match[2]) - 1;
  return match[1] === "r"
    ? { kind: "region", expression: `window.__estacodaRegions?.[${index}]` }
    : { kind: "element", expression: `window.__estacodaElements?.[${index}]` };
}

function runtimeEvaluationRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !isRecord(value.result) || !isRecord(value.result.value)) return undefined;
  return value.result.value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
