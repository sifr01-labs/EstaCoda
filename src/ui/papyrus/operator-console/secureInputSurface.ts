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
import type { ParsedKeypress } from "../../input/parseKeypress.js";
import { SecretPromptController } from "../input/secretPromptController.js";
import { stringWidth } from "../screen/stringWidth.js";
import type { OperatorConsoleRuntimeHost } from "./operatorConsoleRuntimeHost.js";
import {
  styleBgColor,
  styleBold,
  styleColor,
  type OperatorConsoleStyle,
} from "./operatorConsoleStyle.js";
import type { OperatorConsoleLocale } from "./activeWorkCopy.js";
import {
  renderAttentionCardBottomBorder,
  renderAttentionCardRow,
  renderAttentionCardTopBorder,
  resolveAttentionCardGeometry,
  type AttentionCardGeometry,
} from "./attentionCardFrame.js";
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
    purpose: "Purpose",
    destination: "Verified destination",
    expires: "Expires",
    value: "Value",
    emptyValue: "not entered",
    enterValue: "Select secure entry, then type or paste; input is masked",
    activeValue: "Typing securely; input is masked",
    required: "Enter a value or cancel this request.",
    actions: {
      "enter-securely": "Enter securely",
      "enter-directly": "Type in browser",
      cancel: "Cancel",
    },
    actionFooter: "Tab move · Enter select · Esc cancel",
    entryFooter: "Enter submit · Tab return · Esc cancel",
    safety: "Value never enters model context",
    groupProgress: (index: number, total: number) => `${index} of ${total}`,
  },
  ar: {
    title: "مطلوب إدخال آمن",
    flow: "المسار",
    purpose: "الغرض",
    destination: "الوجهة المتحقق منها",
    expires: "تنتهي الصلاحية",
    value: "القيمة",
    emptyValue: "لم تُدخل",
    enterValue: "اختر الإدخال الآمن، ثم اكتب القيمة أو الصقها؛ سيبقى الإدخال مخفياً",
    activeValue: "تتم الكتابة بأمان؛ سيبقى الإدخال مخفياً",
    required: "أدخل قيمة أو ألغِ هذا الطلب.",
    actions: {
      "enter-securely": "إدخال آمن",
      "enter-directly": "اكتب في المتصفح",
      cancel: "إلغاء",
    },
    actionFooter: "Tab تنقّل · Enter اختيار · Esc إلغاء",
    entryFooter: "Enter إرسال · Tab عودة · Esc إلغاء",
    safety: "القيمة لا تدخل سياق النموذج",
    groupProgress: (index: number, total: number) => `${index} من ${total}`,
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
    entryActive: false,
    focusedAction: "enter-securely",
    ...(context.group === undefined ? {} : { group: { ...context.group } }),
  };
}

export class SecureInputSurfaceController {
  readonly #secret: SecretPromptController;
  readonly #locale: OperatorConsoleLocale;
  #state: SecureInputSurfaceState;

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

    if (!this.#state.entryActive) return this.#applyActionEvent(event);

    if (event.type === "key" && event.key === "tab") {
      this.#state = { ...this.#state, entryActive: false, validationError: undefined };
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
    this.#state = {
      ...this.#state,
      maskedCharacterCount: 0,
      entryActive: false,
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
      this.#state = { ...this.#state, entryActive: true, validationError: undefined };
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

export function getSecureInputSurfaceDesiredHeight(
  state: SecureInputSurfaceState,
  width = 80,
  locale: OperatorConsoleLocale = "en"
): number {
  return renderSecureInputSurface(state, { width, locale }).length;
}

export function renderSecureInputSurface(
  state: SecureInputSurfaceState,
  options: SecureInputSurfaceRenderOptions
): readonly string[] {
  const width = normalizeDimension(options.width);
  if (width <= 0) return [];
  const copy = COPY[options.locale];
  if (width < 4) return [truncateVisibleCells(copy.title, width)];

  const geometry = resolveAttentionCardGeometry(width);
  if (geometry.frameWidth < 4) return [truncateVisibleCells(copy.title, width)];
  const style = options.style;
  const rightLabel = state.group === undefined
    ? undefined
    : prepareTechnicalValue(copy.groupProgress(state.group.index, state.group.total), options.locale);
  const rows: string[] = [renderAttentionCardTopBorder({
    geometry,
    title: prepareValue(copy.title, options.locale),
    ...(rightLabel === undefined ? {} : { rightLabel }),
    style,
    titleColor: style?.tokens.contract.palette.action,
    rightLabelColor: style?.tokens.contract.text.secondary,
  })];

  rows.push(...renderPrimaryText(kindLabel(state.kind, options.locale), geometry, options));
  if (state.group !== undefined) {
    rows.push(...renderSecondaryDetail(copy.flow, state.group.purpose, geometry, options));
  }
  rows.push(...renderSecondaryDetail(copy.purpose, state.purpose, geometry, options));
  rows.push(renderAttentionCardRow("", geometry, style));
  rows.push(renderAttentionCardRow(
    styleColor(style, prepareValue(`✓ ${copy.destination}`, options.locale), style?.tokens.contract.severity.ok ?? ""),
    geometry,
    style
  ));
  rows.push(...renderSecondaryText(state.destinationLabel, geometry, options, true));
  rows.push(...renderMutedMetadata(state, geometry, options));
  rows.push(renderAttentionCardRow("", geometry, style));
  rows.push(...renderValue(state, geometry, options));
  rows.push(...renderMutedText(state.entryActive ? copy.activeValue : copy.enterValue, geometry, options));
  if (state.validationError !== undefined) {
    rows.push(...renderError(state.validationError, geometry, options));
  }
  rows.push(renderAttentionCardRow("", geometry, style));
  rows.push(...renderActions(state, geometry, options));
  rows.push(...renderMutedText(state.entryActive ? copy.entryFooter : copy.actionFooter, geometry, options));
  rows.push(...renderMutedText(copy.safety, geometry, options));
  rows.push(renderAttentionCardBottomBorder(geometry, style));
  const height = normalizeDimension(options.height ?? rows.length);
  return rows.slice(0, height);
}

function renderPrimaryText(
  value: string,
  geometry: AttentionCardGeometry,
  options: SecureInputSurfaceRenderOptions
): readonly string[] {
  return wrapDynamicText(value, geometry.contentWidth, options.locale).map((line) => renderAttentionCardRow(
    styleBold(options.style, styleColor(
      options.style,
      line,
      options.style?.tokens.contract.text.primary ?? ""
    )),
    geometry,
    options.style
  ));
}

function renderSecondaryDetail(
  label: string,
  value: string,
  geometry: AttentionCardGeometry,
  options: SecureInputSurfaceRenderOptions
): readonly string[] {
  return renderSecondaryText(`${label} · ${value}`, geometry, options);
}

function renderSecondaryText(
  value: string,
  geometry: AttentionCardGeometry,
  options: SecureInputSurfaceRenderOptions,
  technical = false
): readonly string[] {
  return wrapDynamicText(value, geometry.contentWidth, options.locale, technical).map((line) => renderAttentionCardRow(
    styleColor(options.style, line, options.style?.tokens.contract.text.secondary ?? ""),
    geometry,
    options.style
  ));
}

function renderMutedMetadata(
  state: SecureInputSurfaceState,
  geometry: AttentionCardGeometry,
  options: SecureInputSurfaceRenderOptions
): readonly string[] {
  const copy = COPY[options.locale];
  return renderMutedText([
    retentionLabel(state.retention, options.locale),
    `${copy.expires} ${formatAbsoluteTimestamp(state.expiresAt)}`,
  ].join(" · "), geometry, options, true);
}

function renderValue(
  state: SecureInputSurfaceState,
  geometry: AttentionCardGeometry,
  options: SecureInputSurfaceRenderOptions
): readonly string[] {
  const copy = COPY[options.locale];
  const empty = state.maskedCharacterCount === 0;
  const value = empty
    ? copy.emptyValue
    : "•".repeat(Math.min(normalizeDimension(state.maskedCharacterCount), geometry.contentWidth));
  const prepared = prepareValue(`${copy.value} · ${value}`, options.locale);
  const color = empty
    ? options.style?.tokens.contract.text.muted
    : state.entryActive
      ? options.style?.tokens.contract.palette.action
      : options.style?.tokens.contract.text.primary;
  return [renderAttentionCardRow(
    styleColor(options.style, truncateVisibleCells(prepared, geometry.contentWidth), color ?? ""),
    geometry,
    options.style
  )];
}

function renderMutedText(
  value: string,
  geometry: AttentionCardGeometry,
  options: SecureInputSurfaceRenderOptions,
  technical = false
): readonly string[] {
  return wrapDynamicText(value, geometry.contentWidth, options.locale, technical).map((line) => renderAttentionCardRow(
    styleColor(options.style, line, options.style?.tokens.contract.text.muted ?? ""),
    geometry,
    options.style
  ));
}

function renderError(
  value: string,
  geometry: AttentionCardGeometry,
  options: SecureInputSurfaceRenderOptions
): readonly string[] {
  return wrapDynamicText(`! ${value}`, geometry.contentWidth, options.locale).map((line) => renderAttentionCardRow(
    styleColor(options.style, line, options.style?.tokens.contract.severity.error ?? ""),
    geometry,
    options.style
  ));
}

function renderActions(
  state: SecureInputSurfaceState,
  geometry: AttentionCardGeometry,
  options: SecureInputSurfaceRenderOptions
): readonly string[] {
  const copy = COPY[options.locale];
  const rawActions = SECURE_INPUT_ACTIONS.map((action) => {
    const active = state.focusedAction === action;
    return {
      action,
      active,
      raw: `${active ? "❯" : " "} ${copy.actions[action]}`,
    };
  });
  const separator = "   ";
  const horizontal = rawActions.reduce((width, action) => width + stringWidth(action.raw), 0) +
    (separator.length * (rawActions.length - 1));
  if (horizontal <= geometry.contentWidth) {
    return [renderAttentionCardRow(
      rawActions.map((action) => styleAction(action.action, action.raw, action.active, options)).join(separator),
      geometry,
      options.style
    )];
  }
  return rawActions.map((action) => renderAttentionCardRow(
    styleAction(action.action, action.raw, action.active, options),
    geometry,
    options.style
  ));
}

function styleAction(
  action: SecureInputAction,
  raw: string,
  active: boolean,
  options: SecureInputSurfaceRenderOptions
): string {
  const prepared = prepareValue(raw, options.locale);
  if (active && options.style !== undefined) {
    return styleBgColor(
      options.style,
      styleColor(options.style, prepared, options.style.tokens.contract.interactive.selected),
      options.style.tokens.contract.interactive.selectedBg
    );
  }
  const color = action === "enter-securely"
    ? options.style?.tokens.contract.palette.action
    : action === "enter-directly"
      ? options.style?.tokens.contract.severity.info
      : options.style?.tokens.contract.severity.error;
  return styleColor(options.style, prepared, color ?? "");
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

function wrapDynamicText(
  value: string,
  width: number,
  locale: OperatorConsoleLocale,
  technical = false
): readonly string[] {
  const safe = sanitizeBidiControls(value).replace(/\r\n?|\n/gu, " ");
  return wrapVisibleCells(safe, width).map((line) => (
    technical ? prepareTechnicalValue(line, locale) : prepareValue(line, locale)
  ));
}

function formatAbsoluteTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return sanitizeBidiControls(value);
  return `${parsed.toISOString().slice(0, 16).replace("T", " ")} UTC`;
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

function truncateVisibleCells(value: string, maxCells: number): string {
  const width = normalizeDimension(maxCells);
  if (width <= 0) return "";
  if (stringWidth(value) <= width) return value;
  let output = "";
  for (const char of value) {
    if (stringWidth(output + char) > width) break;
    output += char;
  }
  return closeOpenBidiIsolates(output);
}

function wrapVisibleCells(value: string, maxCells: number): readonly string[] {
  const width = normalizeDimension(maxCells);
  if (width <= 0 || value.length === 0) return [];
  if (stringWidth(value) <= width) return [value];

  const words = value.split(/(\s+)/u).filter((part) => part.length > 0);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current.length === 0 ? word.trimStart() : `${current}${word}`;
    if (stringWidth(next) <= width) {
      current = next;
      continue;
    }
    if (current.trim().length > 0) lines.push(current.trimEnd());
    current = word.trim();
    while (stringWidth(current) > width) {
      const chunk = truncateVisibleCells(current, width);
      if (chunk.length === 0) {
        const first = Array.from(current)[0];
        if (first === undefined) break;
        lines.push(first);
        current = current.slice(first.length).trimStart();
        continue;
      }
      lines.push(chunk);
      current = current.slice(chunk.length).trimStart();
    }
  }
  if (current.trim().length > 0) lines.push(current.trimEnd());
  return lines.length === 0 ? [truncateVisibleCells(value, width)] : lines;
}

function normalizeDimension(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}
