import type { ParsedKeypress } from "../../input/parseKeypress.js";
import {
  hasRtlText,
  isolateAuto,
  isolateTechnicalTokens,
  sanitizeBidiControls,
} from "../../bidi.js";
import { stringWidth } from "../screen/stringWidth.js";
import {
  createApprovalFocusTarget,
  DEFAULT_APPROVAL_FOCUS_CONTROL,
  setFocus,
} from "./focusModel.js";
import {
  attentionCardHeaderFitsRightLabel,
  renderAttentionCardBottomBorder,
  renderAttentionCardRow,
  renderAttentionCardTopBorder,
  resolveAttentionCardGeometry,
  type AttentionCardGeometry,
} from "./attentionCardFrame.js";
import {
  styleBackgroundRow,
  styleBold,
  styleColor,
  type OperatorConsoleStyle,
} from "./operatorConsoleStyle.js";
import type {
  ApprovalCardScope,
  ApprovalCardState,
  ApprovalControl,
  ApprovalGrantMatch,
  OperatorConsoleState,
} from "./operatorConsoleState.js";

export type ApprovalSurfaceRenderOptions = {
  readonly width: number;
  readonly height?: number;
  readonly locale?: "en" | "ar";
  readonly style?: OperatorConsoleStyle;
};

export type ApprovalIntent =
  | { readonly type: "approve"; readonly approvalId: string; readonly scope: ApprovalCardScope }
  | { readonly type: "reject"; readonly approvalId: string }
  | { readonly type: "inspect"; readonly approvalId: string }
  | { readonly type: "none" };

export type ApprovalKeyResult = {
  readonly state: OperatorConsoleState;
  readonly intent: ApprovalIntent;
};

type ApprovalCopy = {
  readonly titles: Readonly<Record<ApprovalCardState["status"], string>>;
  readonly target: string;
  readonly risk: string;
  readonly controls: Readonly<Record<ApprovalChoiceKey, {
    readonly label: string;
    readonly description: string | Readonly<Record<ApprovalGrantMatch, string>>;
  }>>;
  readonly footer: string;
  readonly statuses: Readonly<Record<Exclude<ApprovalCardState["status"], "pending">, string>>;
  readonly lines: string;
};

type ApprovalChoiceKey = "inspect" | "approveOnce" | "approveSession" | "approveAlways" | "reject";

type ApprovalChoice = {
  readonly key: ApprovalChoiceKey;
  readonly control: ApprovalControl;
  readonly scope?: ApprovalCardScope;
};

const COPY: Readonly<Record<"en" | "ar", ApprovalCopy>> = {
  en: {
    titles: {
      pending: "Approval required",
      approved: "Approval approved",
      rejected: "Approval rejected",
      expired: "Approval expired",
      superseded: "Approval superseded",
    },
    target: "Target",
    risk: "Risk",
    controls: {
      inspect: { label: "Inspect", description: "Review details before deciding" },
      approveOnce: { label: "Approve once", description: "Permit only this action" },
      approveSession: {
        label: "Approve for session",
        description: {
          target: "Permit matches this session",
          tool: "Permit this tool this session",
        },
      },
      approveAlways: {
        label: "Always approve in workspace",
        description: {
          target: "Permit matches here until revoked",
          tool: "Permit this tool here until revoked",
        },
      },
      reject: { label: "Reject", description: "Deny this action" },
    },
    footer: "↑↓ move · Enter select · Esc reject",
    statuses: {
      approved: "Approved once",
      rejected: "Rejected by operator",
      expired: "Approval expired",
      superseded: "Approval superseded",
    },
    lines: "lines",
  },
  ar: {
    titles: {
      pending: "الموافقة مطلوبة",
      approved: "تمت الموافقة",
      rejected: "رُفضت الموافقة",
      expired: "انتهت صلاحية الموافقة",
      superseded: "استُبدلت الموافقة",
    },
    target: "الهدف",
    risk: "المخاطر",
    controls: {
      inspect: { label: "فحص", description: "راجع التفاصيل قبل اتخاذ القرار" },
      approveOnce: { label: "موافقة لمرة واحدة", description: "اسمح بهذا الإجراء فقط" },
      approveSession: {
        label: "موافقة لهذه الجلسة",
        description: {
          target: "اسمح بالإجراءات المطابقة خلال هذه الجلسة",
          tool: "اسمح لهذه الأداة خلال هذه الجلسة",
        },
      },
      approveAlways: {
        label: "موافقة دائمة في مساحة العمل",
        description: {
          target: "اسمح بالإجراءات المطابقة هنا حتى الإلغاء",
          tool: "اسمح لهذه الأداة هنا حتى الإلغاء",
        },
      },
      reject: { label: "رفض", description: "امنع هذا الإجراء" },
    },
    footer: "↑↓ للتنقل · Enter للاختيار · Esc للرفض",
    statuses: {
      approved: "تمت الموافقة لمرة واحدة",
      rejected: "رفض المشغّل الطلب",
      expired: "انتهت صلاحية الموافقة",
      superseded: "استُبدلت الموافقة",
    },
    lines: "سطر",
  },
};

export function getApprovalSurfaceDesiredHeight(
  approvals: readonly ApprovalCardState[],
  width = 80,
  locale: "en" | "ar" = "en"
): number {
  return renderApprovalSurface(approvals, { width, locale }).length;
}

export function renderApprovalSurface(
  approvals: readonly ApprovalCardState[],
  options: ApprovalSurfaceRenderOptions
): readonly string[] {
  const width = normalizeDimension(options.width);
  if (width <= 0 || approvals.length === 0) return [];

  const rows = approvals.flatMap((approval) => renderApprovalCard(approval, width, options));
  return options.height === undefined ? rows : rows.slice(0, normalizeDimension(options.height));
}

export function routeApprovalKey(
  state: OperatorConsoleState,
  key: ParsedKeypress
): ApprovalKeyResult {
  if (key.type !== "key") return { state, intent: { type: "none" } };

  const focused = getFocusedApproval(state);
  if (key.key === "tab" || key.key === "right" || key.key === "left" || key.key === "up" || key.key === "down") {
    if (focused === undefined || focused.approval.status !== "pending") return { state, intent: { type: "none" } };
    const direction = key.key === "left" || key.key === "up" || key.shift === true ? -1 : 1;
    const choice = moveApprovalChoice(focused.approval, focused.choice, direction);
    return {
      state: {
        ...state,
        approvals: state.approvals.map((approval) => approval.id === focused.approval.id
          ? withFocusedApprovalChoice(approval, choice)
          : approval),
        focus: setFocus(state.focus, createApprovalFocusTarget(
          focused.approval.id,
          choice.control,
          choice.scope
        )),
      },
      intent: { type: "none" },
    };
  }

  if (focused === undefined || focused.approval.status !== "pending") return { state, intent: { type: "none" } };

  if (key.key === "enter") {
    return { state, intent: intentForChoice(focused.approval.id, focused.choice) };
  }

  if (key.key === "escape") {
    return { state, intent: { type: "reject", approvalId: focused.approval.id } };
  }

  return { state, intent: { type: "none" } };
}

function renderApprovalCard(
  approval: ApprovalCardState,
  width: number,
  options: Pick<ApprovalSurfaceRenderOptions, "locale" | "style">
): readonly string[] {
  const locale = options.locale ?? "en";
  const copy = COPY[locale];
  const style = options.style;
  const geometry = resolveAttentionCardGeometry(width);
  if (geometry.frameWidth < 4) return [truncateVisibleCells(copy.titles[approval.status], width)];

  const rawTitle = copy.titles[approval.status];
  const title = locale === "ar" ? isolateAuto(rawTitle) : rawTitle;
  const risk = approval.risk === undefined || approval.risk.length === 0
    ? undefined
    : prepareDynamicText(approval.risk, locale);
  const riskInHeader = risk !== undefined &&
    !/[\r\n]/u.test(risk) &&
    attentionCardHeaderFitsRightLabel(geometry, title, risk);
  const rows: string[] = [renderAttentionCardTopBorder({
    geometry,
    title,
    ...(riskInHeader ? { rightLabel: risk } : {}),
    style,
    titleColor: style?.tokens.contract.palette.caution,
    rightLabelColor: style?.tokens.contract.text.secondary,
  })];

  rows.push(...renderPrimaryText(approval.action, geometry, locale, style));
  rows.push(...renderDetail(copy.target, approval.target, geometry, locale, style));
  if (risk !== undefined && !riskInHeader) {
    rows.push(...renderDetail(copy.risk, approval.risk!, geometry, locale, style));
  }
  if (approval.summary !== undefined && approval.summary.length > 0) {
    rows.push(...renderSecondaryText(approval.summary, geometry, locale, style));
  }

  if (approval.diffStats !== undefined) {
    rows.push(renderAttentionCardRow("", geometry, style));
    rows.push(renderDiffStats(approval.diffStats, geometry, copy, style));
  }

  if (approval.status === "pending") {
    rows.push(renderAttentionCardRow("", geometry, style));
    const choices = visibleApprovalChoices(approval);
    for (const choice of choices) {
      rows.push(...renderApprovalChoice(choice, approval, choices, geometry, copy, locale, style));
    }
    rows.push(renderAttentionCardRow("", geometry, style));
    rows.push(...renderFooter(copy.footer, geometry, locale, style));
  } else {
    rows.push(renderAttentionCardRow("", geometry, style));
    rows.push(renderStatus(approval.status, geometry, copy, style));
  }

  rows.push(renderAttentionCardBottomBorder(geometry, style));
  return rows;
}

function renderPrimaryText(
  value: string,
  geometry: AttentionCardGeometry,
  locale: "en" | "ar",
  style: OperatorConsoleStyle | undefined
): readonly string[] {
  return wrapDynamicText(value, geometry.contentWidth, locale).map((line) => renderAttentionCardRow(
    styleBold(style, styleColor(style, line, style?.tokens.contract.text.primary ?? "")),
    geometry,
    style
  ));
}

function renderDetail(
  label: string,
  value: string,
  geometry: AttentionCardGeometry,
  locale: "en" | "ar",
  style: OperatorConsoleStyle | undefined
): readonly string[] {
  return wrapDynamicText(`${label} · ${value}`, geometry.contentWidth, locale).map((line) => renderAttentionCardRow(
    styleColor(style, line, style?.tokens.contract.text.secondary ?? ""),
    geometry,
    style
  ));
}

function renderSecondaryText(
  value: string,
  geometry: AttentionCardGeometry,
  locale: "en" | "ar",
  style: OperatorConsoleStyle | undefined
): readonly string[] {
  return wrapDynamicText(value, geometry.contentWidth, locale).map((line) => renderAttentionCardRow(
    styleColor(style, line, style?.tokens.contract.text.secondary ?? ""),
    geometry,
    style
  ));
}

function renderApprovalChoice(
  choice: ApprovalChoice,
  approval: ApprovalCardState,
  visibleChoices: readonly ApprovalChoice[],
  geometry: AttentionCardGeometry,
  copy: ApprovalCopy,
  locale: "en" | "ar",
  style: OperatorConsoleStyle | undefined
): readonly string[] {
  const active = isFocusedApprovalChoice(approval, choice);
  const marker = active ? "❯ " : "  ";
  const item = copy.controls[choice.key];
  const description = typeof item.description === "string"
    ? item.description
    : item.description[approval.grantMatch ?? "target"];
  const labelWidth = Math.max(...visibleChoices.map((candidate) => stringWidth(copy.controls[candidate.key].label)));
  const descriptionWidth = geometry.contentWidth - 2 - labelWidth - 2;
  const rawLines = descriptionWidth >= 12
    ? wrapVisibleCells(description, descriptionWidth).map((line, index) => (
        index === 0
          ? `${marker}${padVisibleEnd(item.label, labelWidth)}  ${line}`
          : `${" ".repeat(2 + labelWidth + 2)}${line}`
      ))
    : [
        `${marker}${item.label}`,
        ...wrapVisibleCells(description, Math.max(1, geometry.contentWidth - 2)).map((line) => `  ${line}`),
      ];

  return rawLines.map((rawLine, lineIndex) => {
    const semanticColor = controlColor(choice.control, style);
    const descriptionOffset = descriptionWidth >= 12
      ? 2 + labelWidth + 2
      : lineIndex === 0 ? rawLine.length : 2;
    const labelPart = rawLine.slice(0, descriptionOffset);
    const descriptionPart = rawLine.slice(descriptionOffset);
    const colored = active
      ? styleColor(style, rawLine, style?.tokens.contract.interactive.selected ?? "")
      : [
          styleColor(style, labelPart, semanticColor ?? ""),
          styleColor(style, descriptionPart, style?.tokens.contract.text.muted ?? ""),
        ].join("");
    const prepared = locale === "ar" ? isolateAuto(isolateTechnicalTokens(colored)) : colored;
    const content = active && style !== undefined
      ? styleBackgroundRow(style, prepared, geometry.contentWidth, style.tokens.contract.interactive.selectedBg)
      : prepared;
    return renderAttentionCardRow(content, geometry, style);
  });
}

function renderFooter(
  footer: string,
  geometry: AttentionCardGeometry,
  locale: "en" | "ar",
  style: OperatorConsoleStyle | undefined
): readonly string[] {
  return wrapDynamicText(footer, geometry.contentWidth, locale).map((line) => renderAttentionCardRow(
    styleColor(style, line, style?.tokens.contract.text.muted ?? ""),
    geometry,
    style
  ));
}

function renderDiffStats(
  diffStats: NonNullable<ApprovalCardState["diffStats"]>,
  geometry: AttentionCardGeometry,
  copy: ApprovalCopy,
  style: OperatorConsoleStyle | undefined
): string {
  const added = `+${formatNumber(diffStats.added ?? 0)} ${copy.lines}`;
  const removed = `-${formatNumber(diffStats.removed ?? 0)} ${copy.lines}`;
  return renderAttentionCardRow([
    styleColor(style, added, style?.tokens.contract.severity.ok ?? ""),
    "  ",
    styleColor(style, removed, style?.tokens.contract.severity.error ?? ""),
  ].join(""), geometry, style);
}

function renderStatus(
  status: Exclude<ApprovalCardState["status"], "pending">,
  geometry: AttentionCardGeometry,
  copy: ApprovalCopy,
  style: OperatorConsoleStyle | undefined
): string {
  const color = status === "approved"
    ? style?.tokens.contract.severity.ok
    : status === "rejected"
      ? style?.tokens.contract.severity.error
      : style?.tokens.contract.text.muted;
  return renderAttentionCardRow(styleColor(style, copy.statuses[status], color ?? ""), geometry, style);
}

function getFocusedApproval(
  state: OperatorConsoleState
): { readonly approval: ApprovalCardState; readonly choice: ApprovalChoice } | undefined {
  const target = state.focus.target;
  if (target.kind !== "approval") return undefined;
  const approval = state.approvals.find((candidate) => candidate.id === target.approvalId);
  if (approval === undefined) return undefined;
  const visibleChoices = visibleApprovalChoices(approval);
  const requestedControl = approval.focusedControl ?? target.control;
  const requestedScope = approval.focusedScope ?? target.scope ??
    (requestedControl === "approve" ? "once" : undefined);
  const requestedChoice = visibleChoices.find((choice) =>
    choice.control === requestedControl && choice.scope === requestedScope
  );
  return {
    approval,
    choice: requestedChoice ?? {
      key: "inspect",
      control: DEFAULT_APPROVAL_FOCUS_CONTROL,
    },
  };
}

function moveApprovalChoice(
  approval: ApprovalCardState,
  choice: ApprovalChoice,
  direction: 1 | -1
): ApprovalChoice {
  const choices = visibleApprovalChoices(approval);
  const index = choices.findIndex((candidate) => candidate.key === choice.key);
  const startIndex = index === -1 ? 0 : index;
  const nextIndex = (startIndex + direction + choices.length) % choices.length;
  return choices[nextIndex]!;
}

function intentForChoice(approvalId: string, choice: ApprovalChoice): ApprovalIntent {
  switch (choice.control) {
    case "approve": return { type: "approve", approvalId, scope: choice.scope ?? "once" };
    case "reject": return { type: "reject", approvalId };
    case "inspect": return { type: "inspect", approvalId };
  }
}

function visibleApprovalChoices(approval: ApprovalCardState): readonly ApprovalChoice[] {
  const scopes = approval.availableScopes ?? ["once"];
  return [
    { key: "inspect", control: "inspect" },
    ...(scopes.includes("once")
      ? [{ key: "approveOnce", control: "approve", scope: "once" } as const]
      : []),
    ...(scopes.includes("session")
      ? [{ key: "approveSession", control: "approve", scope: "session" } as const]
      : []),
    ...(scopes.includes("always")
      ? [{ key: "approveAlways", control: "approve", scope: "always" } as const]
      : []),
    { key: "reject", control: "reject" },
  ];
}

function isFocusedApprovalChoice(approval: ApprovalCardState, choice: ApprovalChoice): boolean {
  if (approval.focusedControl !== choice.control) return false;
  return choice.control !== "approve" || (approval.focusedScope ?? "once") === choice.scope;
}

function withFocusedApprovalChoice(
  approval: ApprovalCardState,
  choice: ApprovalChoice
): ApprovalCardState {
  return {
    ...approval,
    focusedControl: choice.control,
    ...(choice.scope === undefined ? { focusedScope: undefined } : { focusedScope: choice.scope }),
  };
}

function controlColor(
  control: ApprovalControl,
  style: OperatorConsoleStyle | undefined
): string | undefined {
  switch (control) {
    case "inspect": return style?.tokens.contract.severity.info;
    case "approve": return style?.tokens.contract.palette.action;
    case "reject": return style?.tokens.contract.severity.error;
  }
}

function wrapDynamicText(value: string, width: number, locale: "en" | "ar"): readonly string[] {
  const safe = sanitizeBidiControls(value).replace(/\r\n?|\n/gu, " ");
  return wrapVisibleCells(safe, width).map((line) => prepareDynamicText(line, locale));
}

function prepareDynamicText(value: string, locale: "en" | "ar"): string {
  const safe = sanitizeBidiControls(value);
  if (locale !== "ar" && !hasRtlText(safe)) return safe;
  return isolateAuto(isolateTechnicalTokens(safe));
}

function padVisibleEnd(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - stringWidth(value)))}`;
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
  return output;
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

function formatNumber(value: number): string {
  return Math.max(0, Math.floor(value)).toLocaleString("en-US");
}
