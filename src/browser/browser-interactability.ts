import type { BrowserSnapshot } from "../contracts/browser.js";
import { BROWSER_RENDERING_EVALUATOR_SOURCE } from "./browser-page-perception.js";

/**
 * One browser-owned interactability decision, serialized into page evaluation
 * scripts used by discovery, security preflight, and final action dispatch.
 * Keep this function self-contained: it executes inside the inspected page.
 */
export const BROWSER_INTERACTABILITY_EVALUATOR_SOURCE = `(element) => {
  const blocked = (reason, hidden = false, disabled = false) => ({ interactable: false, reason, hidden, disabled });
  const doc = element?.ownerDocument;
  if (!element || element.nodeType !== 1 || element.isConnected !== true || !doc) {
    return blocked('detached', true, false);
  }
  const view = doc.defaultView;
  const styleFor = (candidate) => view?.getComputedStyle?.(candidate) || getComputedStyle(candidate);
  const assessRendering = ${BROWSER_RENDERING_EVALUATOR_SOURCE};
  const visuallyHidden = (candidate, includeGeometry) => {
    return !assessRendering(candidate, includeGeometry).rendered;
  };
  if (visuallyHidden(element, true)) return blocked('hidden', true, false);

  for (let current = element; current && current.nodeType === 1; current = current.parentElement) {
    if (current.inert === true || current.hasAttribute?.('inert')) return blocked('inert', false, false);
  }

  let nativelyDisabled = false;
  try { nativelyDisabled = element.matches?.(':disabled') === true; } catch {}
  let ariaDisabled = false;
  let disabledFieldset = false;
  for (let current = element; current && current.nodeType === 1; current = current.parentElement) {
    if (current.getAttribute?.('aria-disabled') === 'true') ariaDisabled = true;
    if (String(current.tagName || '').toLowerCase() !== 'fieldset' || !current.hasAttribute?.('disabled')) continue;
    const firstLegend = Array.from(current.children || []).find((child) => String(child.tagName || '').toLowerCase() === 'legend');
    if (!firstLegend?.contains?.(element)) disabledFieldset = true;
  }
  if (nativelyDisabled || ariaDisabled || disabledFieldset) return blocked('disabled', false, true);

  if (styleFor(element)?.pointerEvents === 'none') return blocked('pointer-events-none', false, false);

  let modals = [];
  try {
    modals = Array.from(doc.querySelectorAll?.('dialog[open],[role="dialog"][aria-modal="true"],[role="alertdialog"][aria-modal="true"]') || [])
      .filter((candidate) => {
        const role = candidate?.getAttribute?.('role');
        const ariaModal = candidate?.getAttribute?.('aria-modal') === 'true' && (role === 'dialog' || role === 'alertdialog');
        let nativeModal = false;
        try { nativeModal = candidate?.matches?.(':modal') === true; } catch {}
        return (nativeModal || ariaModal) && candidate?.isConnected === true && !visuallyHidden(candidate, true);
      });
  } catch {}
  const activeModal = modals.at(-1);
  if (activeModal && !activeModal.contains?.(element)) return blocked('modal-blocked', false, false);

  return { interactable: true, hidden: false, disabled: false };
}`;

export function isBrowserSnapshotElementInteractable(
  element: NonNullable<BrowserSnapshot["elements"]>[number]
): boolean {
  return element.interactable !== false && element.hidden !== true && element.disabled !== true;
}

/** Produces a page-side guard from trusted, code-owned element expressions. */
export function browserInteractabilityGuardSource(elementExpression: string, targetLabel: string): string {
  return `const el = ${elementExpression};
    const assessInteractability = ${BROWSER_INTERACTABILITY_EVALUATOR_SOURCE};
    const interactability = assessInteractability(el);
    if (!interactability.interactable) throw new Error('Browser element is not interactable (' + interactability.reason + '): ' + ${JSON.stringify(targetLabel)});`;
}

export function assertBrowserRuntimeEvaluationSucceeded(value: unknown): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  if ((value as Record<string, unknown>).exceptionDetails !== undefined) {
    throw new Error("Browser page rejected the action during final interactability validation; inspect current state before retrying.");
  }
}
