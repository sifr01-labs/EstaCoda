import { describe, expect, it } from "vitest";
import {
  BROWSER_INTERACTABILITY_EVALUATOR_SOURCE,
  assertBrowserRuntimeEvaluationSucceeded,
  isBrowserSnapshotElementInteractable
} from "./browser-interactability.js";

type Evaluation = {
  interactable: boolean;
  reason?: string;
  hidden: boolean;
  disabled: boolean;
};

type FakeStyle = {
  display: string;
  visibility: string;
  contentVisibility: string;
};

class FakeDocument {
  modals: FakeElement[] = [];
  readonly defaultView = {
    getComputedStyle: (element: FakeElement) => element.style
  };

  querySelectorAll(): FakeElement[] {
    return this.modals;
  }
}

class FakeElement {
  readonly nodeType = 1;
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly style: FakeStyle = {
    display: "block",
    visibility: "visible",
    contentVisibility: "visible"
  };
  parentElement: FakeElement | undefined;
  isConnected = true;
  hidden = false;
  inert = false;
  nativeDisabled = false;
  nativeModal = false;
  rects: Array<{ width: number; height: number; left?: number; top?: number }> = [{ width: 100, height: 30 }];

  constructor(
    readonly ownerDocument: FakeDocument,
    readonly tagName = "BUTTON"
  ) {}

  append(child: FakeElement): FakeElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  matches(selector: string): boolean {
    return selector === ":disabled" ? this.nativeDisabled : selector === ":modal" && this.nativeModal;
  }

  getClientRects() {
    return this.rects;
  }

  contains(candidate: FakeElement): boolean {
    for (let current: FakeElement | undefined = candidate; current !== undefined; current = current.parentElement) {
      if (current === this) return true;
    }
    return false;
  }
}

const evaluate = Function(`return (${BROWSER_INTERACTABILITY_EVALUATOR_SOURCE});`)() as
  (element: FakeElement | undefined) => Evaluation;

describe("shared browser interactability evaluator", () => {
  it("keeps visible offscreen controls actionable", () => {
    const element = new FakeElement(new FakeDocument());
    element.rects = [{ width: 100, height: 30, left: -2_000, top: 8_000 }];

    expect(evaluate(element)).toEqual({ interactable: true, hidden: false, disabled: false });
  });

  it.each([
    ["hidden attribute", (ancestor: FakeElement) => { ancestor.hidden = true; }],
    ["display none", (ancestor: FakeElement) => { ancestor.style.display = "none"; }],
    ["visibility hidden", (ancestor: FakeElement) => { ancestor.style.visibility = "hidden"; }],
    ["visibility collapse", (ancestor: FakeElement) => { ancestor.style.visibility = "collapse"; }],
    ["content visibility hidden", (ancestor: FakeElement) => { ancestor.style.contentVisibility = "hidden"; }],
    ["aria hidden", (ancestor: FakeElement) => { ancestor.attributes.set("aria-hidden", "true"); }]
  ])("blocks a control under %s on an ancestor", (_label, configure) => {
    const doc = new FakeDocument();
    const ancestor = new FakeElement(doc, "DIV");
    const element = ancestor.append(new FakeElement(doc));
    configure(ancestor);

    expect(evaluate(element)).toMatchObject({ interactable: false, reason: "hidden", hidden: true });
  });

  it("blocks empty geometry, detached controls, and inert ancestry", () => {
    const doc = new FakeDocument();
    const empty = new FakeElement(doc);
    empty.rects = [{ width: 0, height: 30 }];
    const detached = new FakeElement(doc);
    detached.isConnected = false;
    const inertParent = new FakeElement(doc, "DIV");
    inertParent.inert = true;
    const inert = inertParent.append(new FakeElement(doc));

    expect(evaluate(empty)).toMatchObject({ interactable: false, reason: "hidden" });
    expect(evaluate(detached)).toMatchObject({ interactable: false, reason: "detached" });
    expect(evaluate(inert)).toMatchObject({ interactable: false, reason: "inert", hidden: false });
  });

  it("blocks native, ARIA, and disabled-fieldset controls while preserving the first legend exception", () => {
    const doc = new FakeDocument();
    const native = new FakeElement(doc);
    native.nativeDisabled = true;
    const ariaParent = new FakeElement(doc, "DIV");
    ariaParent.attributes.set("aria-disabled", "true");
    const aria = ariaParent.append(new FakeElement(doc));
    const fieldset = new FakeElement(doc, "FIELDSET");
    fieldset.attributes.set("disabled", "");
    const legend = fieldset.append(new FakeElement(doc, "LEGEND"));
    const legendControl = legend.append(new FakeElement(doc));
    const disabledControl = fieldset.append(new FakeElement(doc));

    expect(evaluate(native)).toMatchObject({ interactable: false, reason: "disabled", disabled: true });
    expect(evaluate(aria)).toMatchObject({ interactable: false, reason: "disabled", disabled: true });
    expect(evaluate(disabledControl)).toMatchObject({ interactable: false, reason: "disabled", disabled: true });
    expect(evaluate(legendControl)).toEqual({ interactable: true, hidden: false, disabled: false });
  });

  it("allows controls inside the active modal and blocks background controls", () => {
    const doc = new FakeDocument();
    const background = new FakeElement(doc);
    const modal = new FakeElement(doc, "DIALOG");
    modal.nativeModal = true;
    const modalControl = modal.append(new FakeElement(doc));
    doc.modals = [modal];

    expect(evaluate(background)).toMatchObject({ interactable: false, reason: "modal-blocked" });
    expect(evaluate(modalControl)).toEqual({ interactable: true, hidden: false, disabled: false });
  });

  it("does not treat an open non-modal dialog as a background blocker", () => {
    const doc = new FakeDocument();
    const background = new FakeElement(doc);
    doc.modals = [new FakeElement(doc, "DIALOG")];

    expect(evaluate(background)).toEqual({ interactable: true, hidden: false, disabled: false });
  });

  it("uses the same result for snapshot consumers and rejects page evaluation exceptions", () => {
    expect(isBrowserSnapshotElementInteractable({ ref: "@e1", role: "button", interactable: false })).toBe(false);
    expect(isBrowserSnapshotElementInteractable({ ref: "@e1", role: "button" })).toBe(true);
    expect(() => assertBrowserRuntimeEvaluationSucceeded({ exceptionDetails: { text: "Uncaught" } }))
      .toThrow(/final interactability validation/u);
    expect(() => assertBrowserRuntimeEvaluationSucceeded({ result: { value: "clicked" } })).not.toThrow();
  });
});
