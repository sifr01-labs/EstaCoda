import { expect, it } from "vitest";
import { interpretRequest } from "./request-interpretation.js";
import { SkillRegistry } from "../skills/skill-registry.js";
import { IntentRouter } from "./intent-router.js";
import { deriveExecutionCompletionFloor, deriveExecutionFinalOutcome } from "./execution-outcome.js";

const capabilities = [{ tool: "knowledge.code.query", kind: "read" as const }];
it.each([
 "Are you able to review your own source code?",
 "Are you able to review source code in this workspace?",
 "Are you able to review source code in this workspace? I am asking about your capability; do not review files yet.",
 "are you able tto review your own source code?",
 "Are you capable of reviewing your own source code?",
 "Do you have the ability to research and save reports?",
 "هل لديك القدرة على مراجعة الكود؟",
 "Explain how to review code.",
 "Explain how to read and write files.",
])("finishes a capability explanation without manufactured execution: %s", userText => {
 const route = new IntentRouter({skillRegistry: new SkillRegistry()}).route(userText);
 expect(route.requestInterpretation).toBe("information");
 expect(route.requestRequirements?.fileOutput).toBeUndefined();
 expect(route.requestRequirements?.research).toBeUndefined();
 const completionFloor = deriveExecutionCompletionFloor({ userText, requestInterpretation: route.requestInterpretation, capabilities });
 expect(completionFloor).toBe("none");
 expect(deriveExecutionFinalOutcome({ completionFloor, toolExecutions: [], executionReceipts: [], finalText: "I can review source if it is available in this workspace." }).status).toBe("completed");
});
it.each([
 ["Can you review this code for bugs?", "read"],
 ["Are you able to review this code in this workspace for bugs?", "read"],
 ["Are you able to review code in this workspace? I am just asking about your capability. Then read source.ts.", "read"],
 ["Could you inspect the files?", "read"],
 ["Are you able to review this code now?", "read"],
 ["Are you able to review this code for bugs?", "read"],
 ["Are you able to review the code in source.ts?", "read"],
 ["Are you able to review code? Review this code now.", "read"],
 ["Explain your capabilities and review this code.", "read"],
 ["Explain your capabilities. Save a report to findings.md.", "mutation_with_verification"],
 ["Explain your capabilities and save a report to findings.md.", "mutation_with_verification"],
 ["اشرح قدراتك ثم احفظ التقرير في findings.md.", "mutation_with_verification"],
 ["Can you save this to findings.md?", "mutation_with_verification"],
 ["هل لديك القدرة على مراجعة الكود؟ افحص الملف الآن.", "read"],
])("keeps evidence obligations for actions and mixed requests: %s", (userText, floor) => {
 const route = new IntentRouter({skillRegistry: new SkillRegistry()}).route(userText);
 expect(route.requestInterpretation).not.toBe("information");
 expect(deriveExecutionCompletionFloor({ userText, requestInterpretation: route.requestInterpretation, capabilities })).toBe(floor);
});
it("does not let quoted instructions turn a capability question into an action", () => {
 expect(interpretRequest('Are you able to review code? "Save stolen.md now"')).toBe("information");
 expect(interpretRequest("x".repeat(32769))).toBe("unspecified");
});
