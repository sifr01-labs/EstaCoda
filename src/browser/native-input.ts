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
  const index = refToIndex(ref);
  const guard = browserInteractabilityGuardSource(`window.__estacodaElements?.[${index}]`, ref);
  const evaluation = await client.send("Runtime.evaluate", {
    expression: `(() => {
      ${guard}
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || rect.width <= 0 || rect.height <= 0 ||
          !(hit === el || (hit instanceof Node && el.contains(hit)))) {
        throw new Error('Browser target is not pointer-interactable: ${ref}');
      }
      return { x, y };
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

function refToIndex(ref: string): number {
  const match = /^@?e(\d+)$/u.exec(ref);
  if (match === null) throw new Error(`Invalid browser element ref: ${ref}`);
  return Number(match[1]) - 1;
}

function runtimeEvaluationRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !isRecord(value.result) || !isRecord(value.result.value)) return undefined;
  return value.result.value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
