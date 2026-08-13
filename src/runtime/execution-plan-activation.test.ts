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
