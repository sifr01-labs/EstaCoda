import { describe, expect, it } from "vitest";
import { assessExecutionPlanActivation } from "./execution-plan-activation.js";

describe("execution plan activation", () => {
  it("activates for the natural MTN and Postman request", () => {
    expect(assessExecutionPlanActivation({
      userText: "Look at the approved app and set up all 6 products in our Postman collection.",
      proposedToolNames: ["browser.snapshot", "mcp.postman.getCollection"]
    })).toMatchObject({
      required: true,
      reasons: expect.arrayContaining(["multiple-systems", "multiple-targets"])
    });
  });

  it("does not activate for one browser navigation", () => {
    expect(assessExecutionPlanActivation({
      userText: "Open developers.mtn.com.",
      proposedToolNames: ["browser.navigate"]
    }).required).toBe(false);
  });

  it("activates for an authentication objective that hides multiple runtime phases", () => {
    expect(assessExecutionPlanActivation({
      userText: "Spin up a browser and get us into our developer account.",
      proposedToolNames: ["browser.navigate"]
    })).toEqual({ required: true, reasons: ["authentication"] });
    expect(assessExecutionPlanActivation({
      userText: "Sign me in to the MTN portal.",
      proposedToolNames: ["browser.navigate"]
    })).toEqual({ required: true, reasons: ["authentication"] });
    expect(assessExecutionPlanActivation({
      userText: "Get us logged in to our dev account.",
      proposedToolNames: ["browser.navigate"]
    })).toEqual({ required: true, reasons: ["authentication"] });
    expect(assessExecutionPlanActivation({
      userText: "سجّل دخولنا إلى حساب المطور.",
      proposedToolNames: ["browser.navigate"]
    })).toEqual({ required: true, reasons: ["authentication"] });
    expect(assessExecutionPlanActivation({
      userText: "ادخلنا إلى حساب المطور.",
      proposedToolNames: ["browser.navigate"]
    })).toEqual({ required: true, reasons: ["authentication"] });
  });

  it("keeps login explanations and opening a login page out of Mission activation", () => {
    expect(assessExecutionPlanActivation({
      userText: "How do I sign in to the MTN portal?"
    }).required).toBe(false);
    expect(assessExecutionPlanActivation({
      userText: "Open the MTN login page.",
      proposedToolNames: ["browser.navigate"]
    }).required).toBe(false);
    expect(assessExecutionPlanActivation({
      userText: "How do I log in?"
    }).required).toBe(false);
    expect(assessExecutionPlanActivation({
      userText: "What would happen if we logged in?"
    }).required).toBe(false);
  });

  it("does not activate for multi-part read-only questions", () => {
    expect(assessExecutionPlanActivation({
      userText: "What products are listed, which tabs are open, and what is the current collection name?",
      proposedToolNames: ["browser.snapshot", "browser.tabs", "mcp.postman.getCollections"]
    }).required).toBe(false);
  });

  it("does not activate for advice about a multi-step action", () => {
    expect(assessExecutionPlanActivation({
      userText: "Tell me how to test all 6 APIs and then verify their responses.",
      proposedToolNames: []
    }).required).toBe(false);
  });

  it("activates for Arabic multi-target execution", () => {
    expect(assessExecutionPlanActivation({
      userText: "أنشئ كل الطلبات الستة ثم تحقق من النتيجة.",
      proposedToolNames: ["mcp.postman.createCollection"]
    }).required).toBe(true);
  });
});
