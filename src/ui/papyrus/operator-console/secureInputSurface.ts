import type {
  SecureInputCollectionContext,
  SecureInputCollectionResult,
  SecureInputCollector,
  SecureInputRequestSnapshot,
} from "../../../contracts/secure-input.js";
import {
  closeOpenBidiIsolates,
  hasRtlText,
  isolateAuto,
  isolateLtr,
  isolateTechnicalTokens,
  sanitizeBidiControls,
} from "../../bidi.js";
import { truncateVisible } from "../../renderers/layout.js";
import type { ParsedKeypress } from "../../input/parseKeypress.js";
import { SecretPromptController } from "../input/secretPromptController.js";
import { stringWidth } from "../screen/stringWidth.js";
import type { OperatorConsoleRuntimeHost } from "./operatorConsoleRuntimeHost.js";
import { styleColor, type OperatorConsoleStyle } from "./operatorConsoleStyle.js";
import type { OperatorConsoleLocale } from "./activeWorkCopy.js";
import {
  SECURE_INPUT_ACTIONS,
  type SecureInputAction,
  type SecureInputSurfaceState,
} from "./operatorConsoleState.js";

export type SecureInputSurfaceRenderOptions = {
  readonly width: number;
  readonly height?: number;
  readonly locale: OperatorConsoleLocale;
  readonly style?: OperatorConsoleStyle;
};

export type SecureInputSurfaceIntent =
  | { readonly type: "none" }
  | { readonly type: "submit"; readonly value: string }
  | { readonly type: "enter-directly" }
  | { readonly type: "cancel" };

export type SecureInputSurfaceApplyResult = {
  readonly state: SecureInputSurfaceState;
  readonly intent: SecureInputSurfaceIntent;
};

export type OperatorConsoleSecureInputCollectorOptions = {
  /** Signals metadata-only surface changes so a live console can redraw immediately. */
  readonly onSurfaceChange?: () => void;
};

const COPY = {
  en: {
    title: "Secure input required",
    flow: "Flow",
    field: "Field",
    kind: "Request",
    purpose: "Purpose",
    destination: "Verified destination",
    retention: "Retention",
    expires: "Expires",
    value: "Value",
    emptyValue: "not entered",
    enterValue: "Select secure entry, then type or paste; input is masked",
    required: "Enter a value or cancel this request.",
    actions: {
      "enter-securely": "Enter securely",
      "enter-directly": "Enter directly in destination",
      cancel: "Cancel",
    },
    footer: "Tab move · Enter select · Esc cancel · value never enters model context",
  },
  ar: {
    title: "مطلوب إدخال آمن",
    flow: "المسار",
    field: "الحقل",
    kind: "نوع الطلب",
    purpose: "الغرض",
    destination: "الوجهة المتحقق منها",
    retention: "الاحتفاظ",
    expires: "تنتهي الصلاحية",
    value: "القيمة",
    emptyValue: "لم تُدخل",
    enterValue: "اختر الإدخال الآمن، ثم اكتب القيمة أو الصقها؛ سيبقى الإدخال مخفياً",
    required: "أدخل قيمة أو ألغِ هذا الطلب.",
    actions: {
      "enter-securely": "إدخال آمن",
      "enter-directly": "إدخال مباشر في الوجهة",
      cancel: "إلغاء",
    },
    footer: "Tab تنقّل · Enter اختيار · Esc إلغاء · القيمة لا تدخل سياق النموذج",
  },
} as const;

export function createSecureInputSurfaceState(
  snapshot: SecureInputRequestSnapshot,
  context: SecureInputCollectionContext
): SecureInputSurfaceState {
  return {
    kind: snapshot.request.kind,
    purpose: snapshot.request.purpose,
    destinationLabel: context.verifiedDestinationLabel,
    retention: snapshot.request.retention,
    expiresAt: snapshot.expiresAt,
    maskedCharacterCount: 0,
    focusedAction: "enter-securely",
    ...(context.group === undefined ? {} : { group: { ...context.group } }),
  };
}

export class SecureInputSurfaceController {
  readonly #secret: SecretPromptController;
  readonly #locale: OperatorConsoleLocale;
  #state: SecureInputSurfaceState;
  #phase: "actions" | "entry" = "actions";

  constructor(state: SecureInputSurfaceState, locale: OperatorConsoleLocale = "en") {
    this.#state = cloneSurfaceState(state);
    this.#locale = locale;
    this.#secret = new SecretPromptController({ label: COPY[locale].value, maskCharacter: "•" });
  }

  get renderState(): SecureInputSurfaceState {
    return cloneSurfaceState(this.#state);
  }

  apply(event: ParsedKeypress): SecureInputSurfaceApplyResult {
    if (isCancelKey(event)) {
      this.clear();
      return { state: this.renderState, intent: { type: "cancel" } };
    }

    if (this.#phase === "actions") return this.#applyActionEvent(event);

    if (event.type === "key" && event.key === "tab") {
      this.#phase = "actions";
      this.#state = { ...this.#state, validationError: undefined };
      return { state: this.renderState, intent: { type: "none" } };
    }

    if (event.type === "key" && event.key === "enter" && this.#state.maskedCharacterCount === 0) {
      this.#state = { ...this.#state, validationError: COPY[this.#locale].required };
      return { state: this.renderState, intent: { type: "none" } };
    }

    const result = this.#secret.apply(event);
    this.#state = {
      ...this.#state,
      maskedCharacterCount: result.renderState.charCount,
      validationError: undefined,
    };
    if (result.intent?.type === "submit") {
      const value = result.intent.value;
      this.clear();
      return { state: this.renderState, intent: { type: "submit", value } };
    }
    if (result.intent?.type === "cancel" || result.intent?.type === "eof") {
      this.clear();
      return { state: this.renderState, intent: { type: "cancel" } };
    }
    return { state: this.renderState, intent: { type: "none" } };
  }

  clear(): void {
    this.#secret.clear();
    this.#phase = "actions";
    this.#state = {
      ...this.#state,
      maskedCharacterCount: 0,
      validationError: undefined,
      focusedAction: "enter-securely",
    };
  }

  #applyActionEvent(event: ParsedKeypress): SecureInputSurfaceApplyResult {
    if (event.type !== "key") return { state: this.renderState, intent: { type: "none" } };
    if (event.key === "tab" || event.key === "right" || event.key === "left") {
      const direction = event.key === "left" || event.shift === true ? -1 : 1;
      this.#state = {
        ...this.#state,
        focusedAction: moveAction(this.#state.focusedAction, direction),
        validationError: undefined,
      };
      return { state: this.renderState, intent: { type: "none" } };
    }
    if (event.key !== "enter") return { state: this.renderState, intent: { type: "none" } };
    if (this.#state.focusedAction === "enter-securely") {
      this.#phase = "entry";
      this.#state = { ...this.#state, validationError: undefined };
      return { state: this.renderState, intent: { type: "none" } };
    }
    if (this.#state.focusedAction === "enter-directly") {
      this.clear();
      return { state: this.renderState, intent: { type: "enter-directly" } };
    }
    this.clear();
    return { state: this.renderState, intent: { type: "cancel" } };
  }
}

/** Bridges the modal Papyrus surface to the runtime collector without storing raw input in console state. */
export class OperatorConsoleSecureInputCollector {
  readonly #host: OperatorConsoleRuntimeHost;
  readonly #onSurfaceChange: (() => void) | undefined;
  #active:
    | {
        readonly controller: SecureInputSurfaceController;
        readonly resolve: (result: SecureInputCollectionResult) => void;
        readonly signal: AbortSignal;
        readonly onAbort: () => void;
      }
    | undefined;

  constructor(
    host: OperatorConsoleRuntimeHost,
    options: OperatorConsoleSecureInputCollectorOptions = {}
  ) {
    this.#host = host;
    this.#onSurfaceChange = options.onSurfaceChange;
  }

  readonly collect: SecureInputCollector = async (snapshot, signal, context) => {
    if (this.#active !== undefined) throw new Error("A protected-input request is already active.");
    if (signal.aborted) return { status: "cancelled" };

    const controller = new SecureInputSurfaceController(
      createSecureInputSurfaceState(snapshot, context),
      this.#host.getState().locale
    );
    return await new Promise<SecureInputCollectionResult>((resolve) => {
      const onAbort = () => this.#finish({ status: "cancelled" });
      this.#active = { controller, resolve, signal, onAbort };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#setSurface(controller.renderState);
    });
  };

  routeInput(event: ParsedKeypress): boolean {
    const active = this.#active;
    if (active === undefined) return false;
    const result = active.controller.apply(event);
    if (result.intent.type === "submit") {
      this.#finish({ status: "provided", value: new TextEncoder().encode(result.intent.value) });
    } else if (result.intent.type === "cancel" || result.intent.type === "enter-directly") {
      this.#finish({ status: "cancelled" });
    } else {
      this.#setSurface(result.state);
    }
    return true;
  }

  dispose(): void {
    this.#finish({ status: "cancelled" });
  }

  #finish(result: SecureInputCollectionResult): void {
    const active = this.#active;
    if (active === undefined) return;
    this.#active = undefined;
    active.signal.removeEventListener("abort", active.onAbort);
    active.controller.clear();
    this.#setSurface(undefined);
    active.resolve(result);
  }

  #setSurface(state: SecureInputSurfaceState | undefined): void {
    this.#host.setSecureInput(state);
    this.#onSurfaceChange?.();
  }
}

export function getSecureInputSurfaceDesiredHeight(state: SecureInputSurfaceState): number {
  const groupRows = state.group === undefined ? 0 : 2;
  return (state.validationError === undefined ? 11 : 12) + groupRows;
}

export function renderSecureInputSurface(
  state: SecureInputSurfaceState,
  options: SecureInputSurfaceRenderOptions
): readonly string[] {
  const width = normalizeDimension(options.width);
  if (width <= 0) return [];
  const copy = COPY[options.locale];
  if (width < 4) return [truncateVisibleCells(copy.title, width)];

  const contentWidth = Math.max(0, width - 4);
  const value = state.maskedCharacterCount === 0
    ? copy.emptyValue
    : "•".repeat(Math.min(normalizeDimension(state.maskedCharacterCount), contentWidth));
  const rows = [
    renderTopBorder(copy.title, width),
    ...(state.group === undefined ? [] : [
      renderContentRow(formatField(copy.flow, state.group.purpose, options.locale), contentWidth, width),
      renderContentRow(formatField(copy.field, `${state.group.index} / ${state.group.total}`, options.locale, true), contentWidth, width),
    ]),
    renderContentRow(formatField(copy.kind, kindLabel(state.kind, options.locale), options.locale), contentWidth, width),
    renderContentRow(formatField(copy.purpose, state.purpose, options.locale), contentWidth, width),
    renderContentRow(formatField(copy.destination, state.destinationLabel, options.locale, true), contentWidth, width),
    renderContentRow(formatField(copy.retention, retentionLabel(state.retention, options.locale), options.locale), contentWidth, width),
    renderContentRow(formatField(copy.expires, state.expiresAt, options.locale, true), contentWidth, width),
    renderContentRow(formatField(copy.value, value, options.locale), contentWidth, width),
    renderContentRow(prepareValue(copy.enterValue, options.locale), contentWidth, width),
    ...(state.validationError === undefined
      ? []
      : [renderContentRow(`! ${prepareValue(state.validationError, options.locale)}`, contentWidth, width)]),
    renderContentRow(formatActions(state.focusedAction, copy.actions, options), contentWidth, width),
    renderContentRow(prepareValue(copy.footer, options.locale), contentWidth, width),
    renderBottomBorder(width),
  ];
  const height = normalizeDimension(options.height ?? rows.length);
  return rows.slice(0, height);
}

function formatActions(
  focused: SecureInputAction,
  actions: (typeof COPY)[OperatorConsoleLocale]["actions"],
  options: SecureInputSurfaceRenderOptions
): string {
  return SECURE_INPUT_ACTIONS.map((action) => {
    const label = prepareValue(actions[action], options.locale);
    const marker = focused === action ? "❯" : " ";
    const color = options.style?.tokens.contract.palette.action;
    const styledMarker = focused === action && color !== undefined
      ? styleColor(options.style, marker, color)
      : marker;
    return `${styledMarker} ${label}`;
  }).join("   ");
}

function formatField(label: string, value: string, locale: OperatorConsoleLocale, technical = false): string {
  return `${label}: ${technical ? prepareTechnicalValue(value, locale) : prepareValue(value, locale)}`;
}

function prepareValue(value: string, locale: OperatorConsoleLocale): string {
  const safe = sanitizeBidiControls(value);
  if (locale !== "ar" && !hasRtlText(safe)) return safe;
  return isolateAuto(isolateTechnicalTokens(safe));
}

function prepareTechnicalValue(value: string, locale: OperatorConsoleLocale): string {
  const safe = sanitizeBidiControls(value);
  if (locale === "ar" && !hasRtlText(safe)) return isolateLtr(safe);
  return hasRtlText(safe) ? isolateAuto(safe) : safe;
}

function moveAction(action: SecureInputAction, direction: 1 | -1): SecureInputAction {
  const index = SECURE_INPUT_ACTIONS.indexOf(action);
  return SECURE_INPUT_ACTIONS[(index + direction + SECURE_INPUT_ACTIONS.length) % SECURE_INPUT_ACTIONS.length]!;
}

function isCancelKey(event: ParsedKeypress): boolean {
  return event.type === "key" && (event.key === "escape" || (event.ctrl === true && event.key === "c"));
}

function cloneSurfaceState(state: SecureInputSurfaceState): SecureInputSurfaceState {
  return { ...state, ...(state.group === undefined ? {} : { group: { ...state.group } }) };
}

function kindLabel(kind: SecureInputSurfaceState["kind"], locale: OperatorConsoleLocale): string {
  const en: Record<SecureInputSurfaceState["kind"], string> = {
    "account-identifier": "Email or account ID",
    password: "Password",
    "one-time-code": "One-time code",
    "api-key": "API key",
    "client-secret": "Client secret",
    "access-token": "Access token",
    "private-key": "Private key",
    "recovery-code": "Recovery code",
    "generic-secret": "Protected value",
  };
  const ar: Record<SecureInputSurfaceState["kind"], string> = {
    "account-identifier": "البريد الإلكتروني أو معرّف الحساب",
    password: "كلمة مرور",
    "one-time-code": "رمز لمرة واحدة",
    "api-key": "مفتاح API",
    "client-secret": "سر العميل",
    "access-token": "رمز وصول",
    "private-key": "مفتاح خاص",
    "recovery-code": "رمز استرداد",
    "generic-secret": "قيمة محمية",
  };
  return (locale === "ar" ? ar : en)[kind];
}

function retentionLabel(retention: SecureInputSurfaceState["retention"], locale: OperatorConsoleLocale): string {
  const en = { "use-once": "Use once", "destination-managed": "Managed by destination", "profile-secret-store": "Profile secret store" } as const;
  const ar = { "use-once": "استخدام مرة واحدة", "destination-managed": "تديرها الوجهة", "profile-secret-store": "مخزن أسرار الملف الشخصي" } as const;
  return (locale === "ar" ? ar : en)[retention];
}

function renderTopBorder(title: string, width: number): string {
  if (width <= 1) return "╭".slice(0, width);
  const label = `─ ${title} `;
  const remaining = Math.max(0, width - 2 - stringWidth(label));
  return truncateVisibleCells(`╭${label}${"─".repeat(remaining)}╮`, width);
}

function renderBottomBorder(width: number): string {
  if (width <= 1) return "╰".slice(0, width);
  return `╰${"─".repeat(Math.max(0, width - 2))}╯`;
}

function renderContentRow(value: string, contentWidth: number, width: number): string {
  const content = truncateVisibleCells(value, contentWidth);
  const padding = " ".repeat(Math.max(0, contentWidth - stringWidth(content)));
  return truncateVisibleCells(`│ ${content}${padding} │`, width);
}

function truncateVisibleCells(value: string, maxCells: number): string {
  const width = normalizeDimension(maxCells);
  if (width <= 0) return "";
  return closeOpenBidiIsolates(truncateVisible(value, width, ""));
}

function normalizeDimension(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}
