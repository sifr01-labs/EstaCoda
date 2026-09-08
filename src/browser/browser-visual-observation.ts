import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { BrowserScreenshotResult, BrowserStateIdentity } from "../contracts/browser.js";

type VisualObservationClient = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
};

type SensitiveRect = { left: number; top: number; width: number; height: number };

const DOM_REVISION_EVALUATOR_SOURCE = `() => {
  let hash = 2166136261;
  const mix = (value) => {
    const text = String(value || '');
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  };
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let count = 0;
  for (let node = walker.currentNode; node && count < 12000; node = walker.nextNode()) {
    count += 1;
    if (node.nodeType === Node.TEXT_NODE) {
      mix((node.nodeValue || '').slice(0, 240));
      continue;
    }
    const element = node;
    mix(element.tagName);
    for (const name of ['class', 'role', 'aria-hidden', 'aria-expanded', 'disabled', 'hidden', 'style']) {
      if (element.hasAttribute?.(name)) mix(name + '=' + element.getAttribute(name));
    }
  }
  mix(count);
  return hash >>> 0;
}`;

export type BrowserVisualLeaseState = {
  screenshotId: string;
  sessionId?: string;
  tabRef?: string;
  identity?: BrowserStateIdentity;
  cssWidth: number;
  cssHeight: number;
  pixelWidth: number;
  pixelHeight: number;
  scrollX: number;
  scrollY: number;
  mutationRevision: number;
};

export async function captureGovernedBrowserScreenshot(input: {
  client: VisualObservationClient;
  sessionId?: string;
  tabRef?: string;
  identity?: BrowserStateIdentity;
}): Promise<{ screenshot: BrowserScreenshotResult; lease: BrowserVisualLeaseState }> {
  const observed = await inspectVisualSurface(input.client);
  const captured = await input.client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false
  }) as { data?: unknown };
  if (typeof captured.data !== "string") throw new Error("CDP screenshot did not return image data.");
  const afterCapture = await inspectCurrentVisualSurface(input.client);
  if (afterCapture.cssWidth !== observed.cssWidth || afterCapture.cssHeight !== observed.cssHeight ||
      afterCapture.scrollX !== observed.scrollX || afterCapture.scrollY !== observed.scrollY ||
      afterCapture.mutationRevision !== observed.mutationRevision) {
    throw new Error("Browser visual surface changed during sanitized capture. Request a fresh screenshot.");
  }

  const source = Buffer.from(captured.data, "base64");
  const metadata = await sharp(source).metadata();
  const pixelWidth = metadata.width ?? Math.max(1, Math.round(observed.cssWidth));
  const pixelHeight = metadata.height ?? Math.max(1, Math.round(observed.cssHeight));
  const sanitized = await maskSensitiveRegions(source, observed.rects, {
    cssWidth: observed.cssWidth,
    cssHeight: observed.cssHeight,
    pixelWidth,
    pixelHeight
  });
  const screenshotId = randomUUID();
  const observation = {
    screenshotId,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.tabRef === undefined ? {} : { tabRef: input.tabRef }),
    ...(input.identity === undefined ? {} : { identity: { ...input.identity } }),
    captureScope: "viewport" as const,
    sanitized: true as const,
    maskedRegionCount: observed.rects.length,
    viewport: { cssWidth: observed.cssWidth, cssHeight: observed.cssHeight, pixelWidth, pixelHeight }
  };
  return {
    screenshot: { mimeType: "image/png", base64: sanitized.toString("base64"), observation },
    lease: {
      screenshotId,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.tabRef === undefined ? {} : { tabRef: input.tabRef }),
      ...(input.identity === undefined ? {} : { identity: { ...input.identity } }),
      cssWidth: observed.cssWidth,
      cssHeight: observed.cssHeight,
      pixelWidth,
      pixelHeight,
      scrollX: observed.scrollX,
      scrollY: observed.scrollY,
      mutationRevision: observed.mutationRevision
    }
  };
}

export async function inspectCurrentVisualSurface(client: VisualObservationClient): Promise<{
  cssWidth: number;
  cssHeight: number;
  scrollX: number;
  scrollY: number;
  mutationRevision: number;
}> {
  const value = await evaluateJson(client, `(() => {
    const domRevision = (${DOM_REVISION_EVALUATOR_SOURCE})();
    return {
      cssWidth: Number(window.innerWidth || document.documentElement?.clientWidth || 0),
      cssHeight: Number(window.innerHeight || document.documentElement?.clientHeight || 0),
      scrollX: Number(window.scrollX || 0),
      scrollY: Number(window.scrollY || 0),
      mutationRevision: domRevision
    };
  })()`);
  return parseSurfaceState(value);
}

async function inspectVisualSurface(client: VisualObservationClient): Promise<{
  cssWidth: number;
  cssHeight: number;
  scrollX: number;
  scrollY: number;
  mutationRevision: number;
  rects: SensitiveRect[];
}> {
  const value = await evaluateJson(client, `(() => {
    const domRevision = (${DOM_REVISION_EVALUATOR_SOURCE})();
    const width = Number(window.innerWidth || document.documentElement?.clientWidth || 0);
    const height = Number(window.innerHeight || document.documentElement?.clientHeight || 0);
    const secretHint = /(password|passcode|one[-_ ]?time|otp|token|api[-_ ]?key|client[-_ ]?secret|consumer[-_ ]?secret|credential|private[-_ ]?key)/i;
    const credentialLabel = /(password|passcode|one[-_ ]?time|otp|(?:consumer|client|api|access|refresh|private)[-_ ]*(?:key|secret|token))/i;
    const selectors = [
      'input[type="password"]', '[data-secret]', '[data-sensitive]', '[autocomplete="current-password"]',
      '[autocomplete="new-password"]', '[autocomplete="one-time-code"]', 'input', 'textarea'
    ];
    const candidates = new Set(document.querySelectorAll(selectors.join(',')));
    const labeledValues = new Set();
    for (const element of document.querySelectorAll('body *')) {
      if (element.children.length > 6) continue;
      const direct = Array.from(element.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.nodeValue || '').join(' ').trim();
      if (secretHint.test(direct) && /[:=]/.test(direct)) candidates.add(element);
      if (direct.length > 0 && direct.length <= 100 && credentialLabel.test(direct) && !/renew|edit|delete|open/i.test(direct)) {
        const sibling = element.nextElementSibling;
        if (sibling) labeledValues.add(sibling);
        const parent = element.parentElement;
        if (parent && parent.children.length <= 6) {
          for (const child of parent.children) if (child !== element) labeledValues.add(child);
        }
      }
    }
    for (const element of labeledValues) candidates.add(element);
    const rects = [];
    for (const element of candidates) {
      const hint = [element.getAttribute('name'), element.id, element.getAttribute('aria-label'),
        element.getAttribute('placeholder'), element.getAttribute('autocomplete'), element.getAttribute('data-secret'),
        element.getAttribute('data-sensitive')].filter(Boolean).join(' ');
      const alwaysSensitive = element.matches('input[type="password"],[data-secret],[data-sensitive],[autocomplete="current-password"],[autocomplete="new-password"],[autocomplete="one-time-code"]');
      const direct = Array.from(element.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.nodeValue || '').join(' ').trim();
      if (!alwaysSensitive && !labeledValues.has(element) && !secretHint.test(hint) && !(secretHint.test(direct) && /[:=]/.test(direct))) continue;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number.parseFloat(style.opacity || '1') <= 0.01) continue;
      const rect = element.getBoundingClientRect();
      const left = Math.max(0, rect.left); const top = Math.max(0, rect.top);
      const right = Math.min(width, rect.right); const bottom = Math.min(height, rect.bottom);
      if (right <= left || bottom <= top) continue;
      rects.push({ left, top, width: right - left, height: bottom - top });
      if (rects.length >= 64) break;
    }
    return {
      cssWidth: width, cssHeight: height, scrollX: Number(window.scrollX || 0), scrollY: Number(window.scrollY || 0),
      mutationRevision: domRevision, rects
    };
  })()`);
  const surface = parseSurfaceState(value);
  const rects = Array.isArray(value.rects) ? value.rects.map(parseRect).filter((rect): rect is SensitiveRect => rect !== undefined) : [];
  return { ...surface, rects };
}

async function maskSensitiveRegions(
  source: Buffer,
  rects: SensitiveRect[],
  viewport: { cssWidth: number; cssHeight: number; pixelWidth: number; pixelHeight: number }
): Promise<Buffer> {
  if (rects.length === 0) return source;
  const scaleX = viewport.pixelWidth / Math.max(1, viewport.cssWidth);
  const scaleY = viewport.pixelHeight / Math.max(1, viewport.cssHeight);
  const overlays = rects.map((rect) => {
    const left = Math.max(0, Math.floor(rect.left * scaleX));
    const top = Math.max(0, Math.floor(rect.top * scaleY));
    const width = Math.max(1, Math.min(viewport.pixelWidth - left, Math.ceil(rect.width * scaleX)));
    const height = Math.max(1, Math.min(viewport.pixelHeight - top, Math.ceil(rect.height * scaleY)));
    return { input: { create: { width, height, channels: 4 as const, background: { r: 24, g: 24, b: 27, alpha: 1 } } }, left, top };
  });
  return sharp(source).composite(overlays).png().toBuffer();
}

async function evaluateJson(client: VisualObservationClient, expression: string): Promise<Record<string, unknown>> {
  const evaluated = await client.send("Runtime.evaluate", { expression: `JSON.stringify(${expression})`, returnByValue: true }) as {
    result?: { value?: unknown };
    exceptionDetails?: unknown;
  };
  if (evaluated.exceptionDetails !== undefined || typeof evaluated.result?.value !== "string") {
    throw new Error("Browser visual surface could not be inspected safely.");
  }
  const parsed = JSON.parse(evaluated.result.value) as unknown;
  if (!isRecord(parsed)) throw new Error("Browser visual surface returned invalid metadata.");
  return parsed;
}

function parseSurfaceState(value: Record<string, unknown>): {
  cssWidth: number; cssHeight: number; scrollX: number; scrollY: number; mutationRevision: number;
} {
  const cssWidth = finitePositive(value.cssWidth);
  const cssHeight = finitePositive(value.cssHeight);
  if (cssWidth === undefined || cssHeight === undefined) throw new Error("Browser viewport dimensions are unavailable.");
  return {
    cssWidth,
    cssHeight,
    scrollX: finite(value.scrollX) ?? 0,
    scrollY: finite(value.scrollY) ?? 0,
    mutationRevision: Math.max(0, Math.floor(finite(value.mutationRevision) ?? 0))
  };
}

function parseRect(value: unknown): SensitiveRect | undefined {
  if (!isRecord(value)) return undefined;
  const left = finite(value.left); const top = finite(value.top);
  const width = finitePositive(value.width); const height = finitePositive(value.height);
  return left === undefined || top === undefined || width === undefined || height === undefined
    ? undefined : { left, top, width, height };
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function finitePositive(value: unknown): number | undefined {
  const number = finite(value);
  return number !== undefined && number > 0 ? number : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
