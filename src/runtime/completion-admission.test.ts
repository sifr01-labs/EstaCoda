import { describe, expect, it } from "vitest";
import { completionAdmissionFeedback } from "./completion-admission.js";

describe("explicit incomplete-work admissions", () => {
  it.each([
    "The model does not fully satisfy that requirement.",
    "The required behavior is not implemented.",
    "**Remaining limitation:** the parameter is not applied.",
    "Blocked by inconsistent inputs. The report is not schema-conformant.",
    "لم أتمكن من إكمال المهمة"
  ])("rejects completion for %s", text => expect(completionAdmissionFeedback(text, true)).toContain("unfinished required work"));

  it.each([
    "The optional feature is not implemented.",
    "Previously the required behavior was missing; it is now verified.",
    "Example: the required behavior is missing.",
    '> The model does not fully satisfy that requirement.',
    'The test asserts "The required behavior is missing."',
    '```text\nRemaining limitation: not implemented.\n```',
    "No required work remains. Verification passed."
  ])("does not turn examples or optional work into obligations: %s", text => expect(completionAdmissionFeedback(text, true)).toBeUndefined());

  it("does not convert an informational answer into execution authority", () => {
    expect(completionAdmissionFeedback("The required behavior is missing.", false)).toBeUndefined();
  });
});
