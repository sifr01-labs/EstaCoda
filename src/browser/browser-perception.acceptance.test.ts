import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { BrowserSnapshot } from "../contracts/browser.js";
import { findBrowserLocator } from "./browser-locator.js";
import { compactBrowserSnapshot } from "./snapshot-compactor.js";

const FIXTURE_PATH = new URL("./fixtures/mtn-apps-perception.html", import.meta.url);
const PRODUCTS = [
  "Loans v2",
  "Product Offering v3",
  "Subscriptions v2",
  "OAuth V1",
  "Payments V1",
  "Usage Management"
] as const;

function snapshot(expanded: boolean, width: 319 | 1280): BrowserSnapshot {
  const appRegion = expanded
    ? `TikTok Connect Callback URL ${PRODUCTS.join(" ")} Renew credentials Open actions menu`
    : "TikTok Connect Callback URL";
  const elements: NonNullable<BrowserSnapshot["elements"]> = [
    {
      ref: "@e1",
      role: "button",
      name: "TikTok Connect",
      text: "TikTok Connect",
      withinText: appRegion,
      regionText: appRegion,
      viewport: "visible"
    },
    {
      ref: "@e2",
      role: "link",
      name: "Callback URL",
      withinText: appRegion,
      regionText: appRegion,
      viewport: width === 319 ? "offscreen" : "visible"
    }
  ];
  if (expanded) {
    for (const product of PRODUCTS) {
      elements.push({
        ref: `@e${elements.length + 1}`,
        role: "link",
        name: product,
        withinText: appRegion,
        regionText: appRegion,
        viewport: width === 319 ? "offscreen" : "visible"
      });
    }
    elements.push(
      { ref: `@e${elements.length + 1}`, role: "button", name: "Renew credentials", withinText: appRegion, regionText: appRegion },
      { ref: `@e${elements.length + 2}`, role: "button", name: "Open actions menu", withinText: appRegion, regionText: appRegion }
    );
  }
  return {
    sessionId: "sanitized-mtn-fixture",
    url: "https://developers.example/apps",
    identity: { documentEpoch: 1, actionRevision: expanded ? 2 : 1, observationId: expanded ? 2 : 1 },
    observedAt: "2026-08-21T00:00:00.000Z",
    readiness: "complete",
    title: "My apps",
    text: appRegion,
    tab: { ref: "@t1", url: "https://developers.example/apps", controlled: true },
    elements,
    regions: [{
      ref: "@r1",
      text: appRegion,
      actionRefs: elements.map((element) => element.ref),
      links: [],
      hitTestable: true,
      viewport: width === 319 ? "partially-visible" : "visible"
    }]
  };
}

describe("sanitized MTN-style browser perception acceptance", () => {
  it("preserves the live structural failure modes without real credentials", () => {
    const html = readFileSync(FIXTURE_PATH, "utf8");

    expect(html).toContain("width: 319px");
    expect(html).toContain("width: 956px");
    expect(html).toContain("class=\"name toggle-app\"");
    expect(html).toMatch(/\.notification-main-container,[\s\S]*opacity: 0;[\s\S]*pointer-events: none;/u);
    expect(html.match(/class="dormant-dialog"/gu)).toHaveLength(2);
    expect(html).not.toMatch(/consumer.?key|consumer.?secret|api.?key/ui);
  });

  it.each([319, 1280] as const)("grounds the collapsed app toggle at a %dpx viewport without closed UI", (width) => {
    const current = snapshot(false, width);
    const result = findBrowserLocator(current, { name: "TikTok Connect" });
    const compacted = compactBrowserSnapshot(current).content;

    expect(result).toMatchObject({ status: "found", candidates: [{ ref: "@e1", role: "button", name: "TikTok Connect" }] });
    expect(compacted).toContain("TikTok Connect");
    expect(compacted).not.toMatch(/Notifications|App delete|Confirm renewal|Edit|Delete/u);
    expect(current.elements?.find((element) => element.name === "Callback URL")?.viewport)
      .toBe(width === 319 ? "offscreen" : "visible");
  });

  it.each([319, 1280] as const)("refreshes the expanded region with six products at a %dpx viewport", (width) => {
    const current = snapshot(true, width);
    const names = new Set(current.elements?.map((element) => element.name));

    for (const product of PRODUCTS) expect(names).toContain(product);
    expect(names).toContain("Renew credentials");
    expect(names).toContain("Open actions menu");
    expect(names).not.toContain("Edit");
    expect(names).not.toContain("Delete");
  });
});
