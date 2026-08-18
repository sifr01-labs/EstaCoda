import type { BrowserSnapshot, BrowserTab } from "../contracts/browser.js";
import { redactSensitiveText } from "../utils/redaction.js";
import { isBrowserSnapshotElementInteractable } from "./browser-interactability.js";
import { isActionableBrowserRole } from "./snapshot-state.js";
import { redactSnapshotSecrets } from "./snapshot-summarizer.js";
import { redactUrlForMetadata } from "./url-safety.js";

const DEFAULT_COMPACT_BUDGET_CHARS = 8_000;
const MAX_RENDERED_LINE_CHARS = 360;
const COMPACTION_SUFFIX = "... [deterministically compacted]";

const AUTHENTICATION_PATTERN = /\b(?:auth(?:enticate|entication)?|challenge|login|log\s*in|sign\s*in|passkey|password|security\s+code|two[-\s]?factor|verification|verify|one[-\s]?time|otp|mfa)\b|(?:تسجيل الدخول|كلمة المرور|رمز التحقق|التحقق|المصادقة)/iu;
const ERROR_PATTERN = /\b(?:alert|denied|error|expired|fail(?:ed|ure)?|incorrect|invalid|required|try again|warning)\b|(?:خطأ|تحذير|فشل|منتهي|غير صالح|مطلوب|حاول مرة أخرى)/iu;

export type BrowserSnapshotCompactionMode = "deterministic";

export type BrowserSnapshotCompactionResult = {
  content: string;
  mode: BrowserSnapshotCompactionMode;
  compacted: boolean;
  truncated: boolean;
  inputChars: number;
  outputChars: number;
  omittedItems: number;
};

export function compactBrowserSnapshot(
  snapshot: BrowserSnapshot,
  options: { maxChars?: number; inputChars?: number } = {}
): BrowserSnapshotCompactionResult {
  const maxChars = normalizeBudget(options.maxChars);
  if (snapshot.sensitiveInputActive === true) {
    const content = [
      "Protected authentication transaction active.",
      "Page content is intentionally suppressed.",
      "State: settling."
    ].join("\n");
    return {
      content,
      mode: "deterministic",
      compacted: false,
      truncated: false,
      inputChars: options.inputChars ?? content.length,
      outputChars: content.length,
      omittedItems: 0
    };
  }

  const elements = (snapshot.elements ?? []).filter(isBrowserSnapshotElementInteractable);
  const text = compactPageText(snapshot.text ?? "", elements);
  const sections = browserSnapshotSections(snapshot, elements, text);
  const exhaustive = renderSections(snapshotHeader(snapshot), sections);
  const inputChars = Math.max(options.inputChars ?? exhaustive.length, exhaustive.length);
  const sourceReduced = text.sourceReduced || inputChars > exhaustive.length;

  if (exhaustive.length <= maxChars) {
    const content = sourceReduced ? appendCompactionSuffix(exhaustive, maxChars) : exhaustive;
    return {
      content,
      mode: "deterministic",
      compacted: sourceReduced,
      truncated: text.truncated,
      inputChars,
      outputChars: content.length,
      omittedItems: text.omitted
    };
  }

  const budgeted = renderBudgetedSections(snapshotHeader(snapshot), sections, maxChars);
  const omittedItems = text.omitted + budgeted.omittedItems;
  return {
    content: budgeted.content,
    mode: "deterministic",
    compacted: true,
    truncated: true,
    inputChars,
    outputChars: budgeted.content.length,
    omittedItems
  };
}

function browserSnapshotSections(
  snapshot: BrowserSnapshot,
  elements: NonNullable<BrowserSnapshot["elements"]>,
  pageText: CompactPageText
): SnapshotSection[] {
  const protectedGuidance = protectedFormGuidance(snapshot, elements);
  const actionState = renderActionState(snapshot);
  const dialogs = (snapshot.pendingDialogs ?? []).slice(0, 5).map((dialog) => {
    const prompt = dialog.defaultPrompt === undefined ? "" : ` default=${safeText(dialog.defaultPrompt)}`;
    return `${safeText(dialog.id)} ${safeText(dialog.type)}: ${safeText(dialog.message)}${prompt}`;
  });
  const elementAlerts = elements
    .filter((element) => element.role === "alert" || element.role === "status")
    .map(renderSnapshotElement);
  const actionable = deduplicateElements(elements.filter((element) => isActionableBrowserRole(element.role)))
    .map(renderSnapshotElement);
  const headings = deduplicateStrings([
    ...elements.filter((element) => element.role === "heading").map(renderSnapshotElement),
    ...pageText.headings
  ]);
  const frames = (snapshot.frameTree ?? []).slice(0, 10).map((frame) => {
    const parent = frame.parentFrameId === undefined ? "" : ` parent=${safeText(frame.parentFrameId)}`;
    const oopif = frame.isOopif ? " oopif" : "";
    return `${safeText(frame.frameId)} ${redactUrlForMetadata(frame.url)} origin=${safeText(frame.origin)}${parent}${oopif}`;
  });
  const consoleEntries = (snapshot.consoleHistory ?? []).slice(-10);
  const consoleErrors = consoleEntries
    .filter((entry) => /^(?:error|warn|warning)$/iu.test(entry.level))
    .map(renderConsoleEntry);
  const consoleOther = consoleEntries
    .filter((entry) => !/^(?:error|warn|warning)$/iu.test(entry.level))
    .map(renderConsoleEntry);

  return [
    section("Navigation/action state:", actionState, 1),
    section("Pending dialogs:", dialogs, 1),
    section("Protected input:", protectedGuidance === undefined ? [] : protectedGuidance.split("\n"), 1),
    section("Errors and alerts:", deduplicateStrings([...elementAlerts, ...pageText.errors]), 1),
    section("Interactive elements:", actionable, 1),
    section("Authentication and challenge context:", pageText.authentication, 1),
    section("Headings and relevant context:", headings, 1),
    section("Frames:", frames, 1),
    section("Console errors:", consoleErrors, 1),
    section("Page context:", pageText.context, 1),
    section("Console:", consoleOther, 0)
  ].filter((entry) => entry.lines.length > 0);
}

function renderActionState(snapshot: BrowserSnapshot): string[] {
  const delta = snapshot.actionDelta;
  if (delta === undefined) return [];
  const lines = [
    `Outcome=${delta.outcome} wait=${delta.waitCondition} conditionMet=${delta.conditionMet}`,
    delta.url.changed
      ? `Navigation: ${delta.url.before === undefined ? "new session" : redactUrlForMetadata(delta.url.before)} -> ${redactUrlForMetadata(delta.url.after)}`
      : `Navigation: unchanged (${redactUrlForMetadata(delta.url.after)})`
  ];
  if (delta.outcome === "dispatched-unverified") {
    lines.push(
      `Settlement verification failed; observation=${delta.stateObservation} documentChangeObserved=${delta.documentChangeObserved}`
    );
  }
  return lines;
}

type SnapshotSection = {
  heading: string;
  lines: string[];
  minimumLines: number;
};

function section(heading: string, lines: string[], minimumLines: number): SnapshotSection {
  return {
    heading,
    lines: lines.map((line) => boundLine(safeText(line))).filter((line) => line.length > 0),
    minimumLines
  };
}

function snapshotHeader(snapshot: BrowserSnapshot): string[] {
  return [
    "[Compact viewport snapshot]",
    `Identity: documentEpoch=${snapshot.identity.documentEpoch} actionRevision=${snapshot.identity.actionRevision} observationId=${snapshot.identity.observationId}`,
    `Observed: ${safeText(snapshot.observedAt)}`,
    `URL: ${redactUrlForMetadata(snapshot.url)}`,
    snapshot.title === undefined ? undefined : `Title: ${safeText(snapshot.title)}`,
    snapshot.readiness === undefined ? undefined : `Readiness: ${snapshot.readiness}`,
    snapshot.tab === undefined ? undefined : `Controlled tab: ${renderSafeTab(snapshot.tab)}`,
    snapshot.openedTabs === undefined || snapshot.openedTabs.length === 0
      ? undefined
      : `Opened tabs: ${snapshot.openedTabs.map((tab) => safeText(tab.ref)).join(", ")}`
  ]
    .filter((line): line is string => line !== undefined)
    .map((line) => boundLine(safeText(line)));
}

function renderSections(header: string[], sections: SnapshotSection[]): string {
  return [
    ...header,
    ...sections.flatMap((entry) => ["", entry.heading, ...entry.lines])
  ].join("\n");
}

function renderBudgetedSections(
  header: string[],
  sections: SnapshotSection[],
  maxChars: number
): { content: string; omittedItems: number } {
  const suffixBudget = COMPACTION_SUFFIX.length + 1;
  const contentBudget = Math.max(0, maxChars - suffixBudget);
  const lines = [...header];
  const included = new Map<SnapshotSection, number>();

  for (const entry of sections) {
    const minimum = Math.min(entry.minimumLines, entry.lines.length);
    if (minimum === 0) continue;
    const block = ["", entry.heading, ...entry.lines.slice(0, minimum)];
    if (fits(lines, block, contentBudget)) {
      lines.push(...block);
      included.set(entry, minimum);
    }
  }

  for (const entry of sections) {
    let count = included.get(entry) ?? 0;
    if (count === 0 && entry.lines.length > 0) {
      const block = ["", entry.heading, entry.lines[0]!];
      if (!fits(lines, block, contentBudget)) continue;
      lines.push(...block);
      count = 1;
    }
    while (count < entry.lines.length && fits(lines, [entry.lines[count]!], contentBudget)) {
      lines.push(entry.lines[count]!);
      count += 1;
    }
    included.set(entry, count);
  }

  const omittedItems = sections.reduce((total, entry) => total + entry.lines.length - (included.get(entry) ?? 0), 0);
  return {
    content: appendCompactionSuffix(lines.join("\n"), maxChars),
    omittedItems
  };
}

function fits(existing: string[], additions: string[], maxChars: number): boolean {
  const currentChars = existing.reduce((total, line) => total + line.length, 0) + Math.max(0, existing.length - 1);
  const addedChars = additions.reduce((total, line) => total + line.length + 1, 0);
  return currentChars + addedChars <= maxChars;
}

function appendCompactionSuffix(content: string, maxChars: number): string {
  if (content.endsWith(COMPACTION_SUFFIX)) return content;
  const available = Math.max(0, maxChars - COMPACTION_SUFFIX.length - 1);
  const prefix = content.slice(0, available).trimEnd();
  return prefix.length === 0 ? COMPACTION_SUFFIX.slice(0, maxChars) : `${prefix}\n${COMPACTION_SUFFIX}`;
}

type CompactPageText = {
  authentication: string[];
  errors: string[];
  headings: string[];
  context: string[];
  omitted: number;
  sourceReduced: boolean;
  truncated: boolean;
};

function compactPageText(
  rawText: string,
  elements: NonNullable<BrowserSnapshot["elements"]>
): CompactPageText {
  const fragments = splitTextFragments(rawText);
  const elementText = new Set(elements.flatMap((element) => [element.name, element.label, element.text])
    .filter((value): value is string => value !== undefined)
    .map(normalizedKey));
  const seen = new Set<string>();
  const authentication: string[] = [];
  const errors: string[] = [];
  const headings: string[] = [];
  const context: string[] = [];
  let omitted = 0;
  let truncated = false;

  for (const fragment of fragments) {
    const safe = safeText(fragment);
    if (safe.length === 0) continue;
    const bounded = boundLine(safe);
    if (bounded.length < safe.length) truncated = true;
    const key = normalizedKey(bounded);
    if (seen.has(key) || elementText.has(key)) {
      omitted += 1;
      continue;
    }
    seen.add(key);
    if (ERROR_PATTERN.test(bounded)) errors.push(bounded);
    else if (AUTHENTICATION_PATTERN.test(bounded)) authentication.push(bounded);
    else if (looksLikeHeading(bounded)) headings.push(bounded);
    else context.push(bounded);
  }

  return {
    authentication,
    errors,
    headings,
    context,
    omitted,
    sourceReduced: omitted > 0 || truncated,
    truncated
  };
}

function splitTextFragments(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .flatMap((line) => line.split(/(?<=[.!?؟])\s+(?=[\p{L}\p{N}])/u))
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter((line) => line.length > 0);
}

function looksLikeHeading(value: string): boolean {
  return value.length <= 120 && !/[.!?؟]$/u.test(value);
}

function deduplicateElements(
  elements: NonNullable<BrowserSnapshot["elements"]>
): NonNullable<BrowserSnapshot["elements"]> {
  const seen = new Set<string>();
  return elements.filter((element) => {
    const key = [element.role, element.name, element.label, element.withinText, element.value, element.checked]
      .map((value) => normalizedKey(String(value ?? "")))
      .join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function deduplicateStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = normalizedKey(value);
    if (key.length === 0 || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function protectedFormGuidance(
  snapshot: BrowserSnapshot,
  elements: NonNullable<BrowserSnapshot["elements"]>
): string | undefined {
  if (snapshot.tab === undefined) return undefined;
  const fields = elements.filter((element) =>
    element.role === "textbox" || element.role === "searchbox" || element.role === "combobox"
  );
  const account = fields.filter((element) =>
    /email|e-mail|user\s*name|account(?:\s*id)?|login\s*id/iu.test([element.name, element.label].filter(Boolean).join(" "))
  );
  const password = fields.filter((element) =>
    /password/iu.test([element.name, element.label].filter(Boolean).join(" "))
  );
  if (account.length !== 1 || password.length !== 1 || account[0]!.ref === password[0]!.ref) return undefined;
  return [
    "Protected form detected: request all related values in one browser.fill_protected_form call; do not request them one at a time.",
    `Use identity=${JSON.stringify(snapshot.identity)}, tabRef=${safeText(snapshot.tab.ref)}, fields=[${safeText(account[0]!.ref)}:account-identifier, ${safeText(password[0]!.ref)}:password].`
  ].join("\n");
}

function renderSnapshotElement(element: NonNullable<BrowserSnapshot["elements"]>[number]): string {
  const redactedValue = element.value === undefined
    ? undefined
    : isProtectedValueElement(element)
      ? "[REDACTED]"
      : element.value;
  const details = [
    element.name,
    element.label === undefined || element.label === element.name ? undefined : `label=${JSON.stringify(element.label)}`,
    element.withinText === undefined ? undefined : `within=${JSON.stringify(element.withinText.slice(0, 120))}`,
    redactedValue === undefined ? undefined : `value=${JSON.stringify(redactedValue)}`,
    element.disabled === undefined ? undefined : `disabled=${element.disabled}`,
    element.checked === undefined ? undefined : `checked=${element.checked}`
  ].filter((part): part is string => part !== undefined && part.length > 0);
  return safeText(`${element.ref} ${element.role ?? "element"} ${details.join(" ")}`.trim());
}

function isProtectedValueElement(element: NonNullable<BrowserSnapshot["elements"]>[number]): boolean {
  return /password|passcode|one[-\s]?time|otp|mfa|verification\s+code|security\s+code|api[-\s_]?key|token|secret|كلمة المرور|رمز التحقق|رمز الأمان/iu
    .test([element.name, element.label].filter(Boolean).join(" "));
}

function renderConsoleEntry(entry: NonNullable<BrowserSnapshot["consoleHistory"]>[number]): string {
  const timestamp = entry.timestamp === undefined ? "" : ` ${safeText(entry.timestamp)}`;
  return `[${safeText(entry.level)}]${timestamp} ${safeText(entry.text)}`.trim();
}

function renderSafeTab(tab: BrowserTab): string {
  const title = tab.title?.trim() === "" || tab.title === undefined ? "Untitled" : safeText(tab.title);
  return `${safeText(tab.ref)}${tab.controlled ? " [controlled]" : ""} ${title} — ${redactUrlForMetadata(tab.url)}`;
}

function safeText(value: string): string {
  return redactSnapshotSecrets(redactSensitiveText(value)).replace(/\s+/gu, " ").trim();
}

function boundLine(value: string): string {
  return value.slice(0, MAX_RENDERED_LINE_CHARS);
}

function normalizedKey(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en");
}

function normalizeBudget(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_COMPACT_BUDGET_CHARS;
  return Math.max(256, Math.floor(value));
}
