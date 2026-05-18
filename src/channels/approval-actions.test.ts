import { describe, expect, it } from "vitest";
import { parseApprovalAction, renderApprovalActions } from "./approval-actions.js";

describe("approval actions", () => {
  it("renders approve and deny action rows without command text", () => {
    const actions = renderApprovalActions("gateway-approval-1");

    expect(actions).toHaveLength(2);
    expect(actions.flat().map((action) => action.label)).toEqual([
      "Allow once",
      "Allow session",
      "Allow always",
      "Deny"
    ]);
    expect(actions.flat().every((action) => action.value.includes("gateway-approval-1"))).toBe(true);
    expect(actions.flat().some((action) => action.label.includes("rm -rf"))).toBe(false);
    expect(actions.flat().some((action) => action.value.includes("rm -rf"))).toBe(false);
  });

  it("parses valid action values", () => {
    const actions = renderApprovalActions("approval:id/with spaces");
    const parsed = actions.flat().map((action) => parseApprovalAction(action.value));

    expect(parsed).toEqual([
      { approvalId: "approval:id/with spaces", decision: "approved", scope: "once" },
      { approvalId: "approval:id/with spaces", decision: "approved", scope: "session" },
      { approvalId: "approval:id/with spaces", decision: "approved", scope: "always" },
      { approvalId: "approval:id/with spaces", decision: "denied", scope: undefined }
    ]);
  });

  it("rejects malformed or unknown action values", () => {
    expect(parseApprovalAction("")).toBeUndefined();
    expect(parseApprovalAction("/approve once")).toBeUndefined();
    expect(parseApprovalAction("ecap1:x:o:approval-1")).toBeUndefined();
    expect(parseApprovalAction("ecap1:a:x:approval-1")).toBeUndefined();
    expect(parseApprovalAction("ecap1:d:o:approval-1")).toBeUndefined();
    expect(parseApprovalAction("ecap1:a:o:")).toBeUndefined();
    expect(parseApprovalAction("ecap1:a:o:%E0%A4%A")).toBeUndefined();
  });
});
