/**
 * Browser-owned page perception helpers serialized into inspected pages.
 *
 * These functions deliberately return only bounded structural facts. They do
 * not expose arbitrary DOM or script execution to the model.
 */
export const BROWSER_RENDERING_EVALUATOR_SOURCE = `(element, includeGeometry = true) => {
  const hidden = (reason) => ({ rendered: false, reason });
  const doc = element?.ownerDocument;
  if (!element || element.nodeType !== 1 || element.isConnected !== true || !doc) return hidden('detached');
  const view = doc.defaultView;
  const styleFor = (candidate) => view?.getComputedStyle?.(candidate) || getComputedStyle(candidate);
  let effectiveOpacity = 1;
  for (let current = element; current && current.nodeType === 1; current = current.parentElement) {
    if (current.hidden === true || current.getAttribute?.('aria-hidden') === 'true') return hidden('hidden');
    const style = styleFor(current);
    if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse' ||
        style?.contentVisibility === 'hidden') return hidden('hidden');
    const opacity = Number.parseFloat(style?.opacity || '1');
    if (Number.isFinite(opacity)) effectiveOpacity *= opacity;
    if (effectiveOpacity <= 0.01) return hidden('transparent');
  }
  if (includeGeometry) {
    const rects = Array.from(element.getClientRects?.() || []);
    if (rects.length === 0 || rects.every((rect) => Number(rect.width) <= 0 || Number(rect.height) <= 0)) {
      return hidden('empty-geometry');
    }
  }
  return { rendered: true, effectiveOpacity };
}`;

export const BROWSER_VIEWPORT_POSITION_EVALUATOR_SOURCE = `(element) => {
  const rect = element?.getBoundingClientRect?.();
  if (!rect || Number(rect.width) <= 0 || Number(rect.height) <= 0) return 'offscreen';
  const view = element.ownerDocument?.defaultView || window;
  const width = Number(view.innerWidth || document.documentElement?.clientWidth || 0);
  const height = Number(view.innerHeight || document.documentElement?.clientHeight || 0);
  if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= width || rect.top >= height) return 'offscreen';
  return rect.left >= 0 && rect.top >= 0 && rect.right <= width && rect.bottom <= height
    ? 'visible'
    : 'partially-visible';
}`;

export const BROWSER_GROUNDED_POINT_EVALUATOR_SOURCE = `(element) => {
  const doc = element?.ownerDocument;
  const view = doc?.defaultView || window;
  const rect = element?.getBoundingClientRect?.();
  if (!doc || !rect || Number(rect.width) <= 0 || Number(rect.height) <= 0) return undefined;
  const width = Number(view.innerWidth || doc.documentElement?.clientWidth || 0);
  const height = Number(view.innerHeight || doc.documentElement?.clientHeight || 0);
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(width, rect.right);
  const bottom = Math.min(height, rect.bottom);
  if (right <= left || bottom <= top) return undefined;
  const insetX = Math.min(8, (right - left) / 4);
  const insetY = Math.min(8, (bottom - top) / 4);
  const points = [
    { x: left + (right - left) / 2, y: top + (bottom - top) / 2 },
    { x: left + insetX, y: top + insetY },
    { x: right - insetX, y: top + insetY },
    { x: left + insetX, y: bottom - insetY },
    { x: right - insetX, y: bottom - insetY }
  ];
  return points.find(({ x, y }) => {
    const hit = doc.elementFromPoint(x, y);
    return hit === element || (hit instanceof Node && element.contains(hit));
  });
}`;

export const BROWSER_VISIBLE_TEXT_EVALUATOR_SOURCE = `(root, maxChars = 12000) => {
  if (!root || maxChars <= 0) return '';
  const assessRendering = ${BROWSER_RENDERING_EVALUATOR_SOURCE};
  const doc = root.ownerDocument || document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const fragments = [];
  let length = 0;
  for (let node = walker.nextNode(); node && length < maxChars; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || parent.closest?.('script,style,noscript,template')) continue;
    if (!assessRendering(parent, true).rendered) continue;
    const text = String(node.nodeValue || '').replace(/\\s+/g, ' ').trim();
    if (!text) continue;
    const bounded = text.slice(0, Math.max(0, maxChars - length));
    fragments.push(bounded);
    length += bounded.length + 1;
  }
  return fragments.join(' ').replace(/\\s+/g, ' ').trim().slice(0, maxChars);
}`;
