import type { GoldenFlow, GoldenFlowAssertion } from "../contracts/golden-flow.js";
import type { Trajectory } from "../contracts/trajectory.js";
import type { EvalResult, EvalAssertion } from "../contracts/eval.js";
import { buildResult } from "./eval-runner.js";

export function compareToGoldenFlow(actual: Trajectory, golden: GoldenFlow): EvalResult {
  const startedAt = Date.now();
  const assertions: EvalAssertion[] = [];

  for (const assertion of golden.assertions) {
    assertions.push(evaluateAssertion(actual, assertion));
  }

  return buildResult(golden.id, `Golden flow: ${golden.name}`, assertions, Date.now() - startedAt);
}

function evaluateAssertion(actual: Trajectory, assertion: GoldenFlowAssertion): EvalAssertion {
  switch (assertion.kind) {
    case "outcome-success": {
      const actualOutcome = actual.outcome?.success ?? false;
      return {
        name: `outcome success = ${assertion.expected}`,
        passed: actualOutcome === assertion.expected,
        expected: String(assertion.expected),
        actual: String(actualOutcome)
      };
    }
    case "event-kind-present": {
      const present = actual.events.some((e) => e.kind === assertion.eventKind);
      return {
        name: `event kind present: ${assertion.eventKind}`,
        passed: present,
        expected: "present",
        actual: present ? "present" : "absent"
      };
    }
    case "event-kind-absent": {
      const absent = !actual.events.some((e) => e.kind === assertion.eventKind);
      return {
        name: `event kind absent: ${assertion.eventKind}`,
        passed: absent,
        expected: "absent",
        actual: absent ? "absent" : "present"
      };
    }
    case "summary-contains": {
      const summary = actual.outcome?.summary ?? "";
      const contains = summary.includes(assertion.substring);
      return {
        name: `summary contains: "${assertion.substring}"`,
        passed: contains,
        expected: `contains "${assertion.substring}"`,
        actual: contains ? undefined : summary
      };
    }
    default: {
      return {
        name: "unknown assertion",
        passed: false,
        expected: "known assertion kind",
        actual: "unknown"
      };
    }
  }
}
