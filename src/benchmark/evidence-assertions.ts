import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { Trajectory, TrajectoryEventKind } from "../contracts/trajectory.js";
import type { BenchmarkMetrics } from "./schema.js";

export type BenchmarkEvidenceAssertion = {
  name: string;
  passed: boolean;
  expected: string;
  actual?: string;
};

export type BenchmarkEvidenceContext = {
  events: readonly RuntimeEvent[];
  trajectory?: Trajectory;
  metrics: BenchmarkMetrics;
  finalAnswer: string;
};

export function assertFileInspected(
  context: BenchmarkEvidenceContext,
  path: string
): BenchmarkEvidenceAssertion {
  const present = context.events.some((event) =>
    event.kind === "tool-start" &&
    event.tool.includes("read") &&
    event.targetSummary === path
  ) || context.trajectory?.events.some((event) =>
    event.kind === "tool-call" &&
    readString(event.data.tool)?.includes("read") === true &&
    readString(event.data.targetSummary) === path
  ) === true;

  return assertion(`file inspected: ${path}`, present, path, present ? undefined : evidenceSummary(context));
}

export function assertCommandAttempted(
  context: BenchmarkEvidenceContext,
  commandSummary: string
): BenchmarkEvidenceAssertion {
  const present = context.events.some((event) =>
    event.kind === "tool-start" &&
    event.tool === "terminal.run" &&
    event.targetSummary === commandSummary
  ) || context.trajectory?.events.some((event) =>
    event.kind === "tool-call" &&
    readString(event.data.tool) === "terminal.run" &&
    readString(event.data.targetSummary) === commandSummary
  ) === true;

  return assertion(`command attempted: ${commandSummary}`, present, commandSummary, present ? undefined : evidenceSummary(context));
}

export function assertPatchTouchesExpectedPath(
  context: BenchmarkEvidenceContext,
  path: string
): BenchmarkEvidenceAssertion {
  const present = context.events.some((event) =>
    event.kind === "tool-start" &&
    (event.tool.includes("write") || event.tool.includes("edit")) &&
    event.targetSummary === path
  ) || context.trajectory?.events.some((event) =>
    event.kind === "tool-call" &&
    /write|edit/u.test(readString(event.data.tool) ?? "") &&
    readString(event.data.targetSummary) === path
  ) === true;

  return assertion(`patch touches expected path: ${path}`, present, path, present ? undefined : evidenceSummary(context));
}

export function assertFinalAnswerContainsRootCause(
  context: BenchmarkEvidenceContext,
  rootCause: string
): BenchmarkEvidenceAssertion {
  const present = context.finalAnswer.includes(rootCause);
  return assertion(`final answer contains root cause: ${rootCause}`, present, rootCause, present ? undefined : context.finalAnswer);
}

export function assertFinalAnswerContainsText(
  context: BenchmarkEvidenceContext,
  text: string
): BenchmarkEvidenceAssertion {
  const present = context.finalAnswer.includes(text);
  return assertion(`final answer contains text: ${text}`, present, text, present ? undefined : context.finalAnswer);
}

export function assertMetricLessThan(
  context: BenchmarkEvidenceContext,
  metric: keyof BenchmarkMetrics,
  threshold: number
): BenchmarkEvidenceAssertion {
  const value = context.metrics[metric];
  const passed = typeof value === "number" && value < threshold;
  return assertion(`metric ${String(metric)} < ${threshold}`, passed, `< ${threshold}`, String(value));
}

export function assertTrajectoryEventKindPresent(
  context: BenchmarkEvidenceContext,
  kind: TrajectoryEventKind
): BenchmarkEvidenceAssertion {
  const present = context.trajectory?.events.some((event) => event.kind === kind) === true;
  return assertion(`trajectory event present: ${kind}`, present, "present", present ? undefined : "absent");
}

export function assertTrajectoryEventKindAbsent(
  context: BenchmarkEvidenceContext,
  kind: TrajectoryEventKind
): BenchmarkEvidenceAssertion {
  const absent = context.trajectory?.events.some((event) => event.kind === kind) !== true;
  return assertion(`trajectory event absent: ${kind}`, absent, "absent", absent ? undefined : "present");
}

export function assertSessionRecallTriggered(context: BenchmarkEvidenceContext): BenchmarkEvidenceAssertion {
  const triggered = context.events.some((event) =>
    event.kind === "session-recall-decision" && event.triggered
  ) || context.trajectory?.events.some((event) =>
    event.kind === "session-recall-decision" && readBoolean(event.data.triggered)
  ) === true;

  return assertion("session recall triggered", triggered, "triggered", triggered ? undefined : "not triggered");
}

export function assertRecalledSourceSession(
  context: BenchmarkEvidenceContext,
  sessionId: string
): BenchmarkEvidenceAssertion {
  const present = context.events.some((event) =>
    event.kind === "session-recall-decision" && event.sourceSessionIds.includes(sessionId)
  ) || context.trajectory?.events.some((event) =>
    event.kind === "session-recall-decision" && readStringArray(event.data.sourceSessionIds).includes(sessionId)
  ) === true;

  return assertion(`recalled source session: ${sessionId}`, present, sessionId, present ? undefined : evidenceSummary(context));
}

export function assertTrajectoryContainsText(
  context: BenchmarkEvidenceContext,
  text: string
): BenchmarkEvidenceAssertion {
  const present = context.trajectory?.events.some((event) =>
    JSON.stringify(event.data).includes(text)
  ) === true;
  return assertion(`trajectory contains text: ${text}`, present, text, present ? undefined : trajectoryTextSummary(context));
}

export function assertTrajectoryExcludesText(
  context: BenchmarkEvidenceContext,
  text: string
): BenchmarkEvidenceAssertion {
  const absent = context.trajectory?.events.some((event) =>
    JSON.stringify(event.data).includes(text)
  ) !== true;
  return assertion(`trajectory excludes text: ${text}`, absent, `no ${text}`, absent ? undefined : trajectoryTextSummary(context));
}

export function assertAllEvidence(assertions: readonly BenchmarkEvidenceAssertion[]): void {
  const failed = assertions.filter((item) => !item.passed);
  if (failed.length === 0) {
    return;
  }

  throw new Error(failed.map((item) =>
    `${item.name}: expected ${item.expected}, actual ${item.actual ?? "undefined"}`
  ).join("\n"));
}

function assertion(name: string, passed: boolean, expected: string, actual?: string): BenchmarkEvidenceAssertion {
  return {
    name,
    passed,
    expected,
    actual
  };
}

function evidenceSummary(context: BenchmarkEvidenceContext): string {
  const runtimeTargets = context.events
    .map((event) => "targetSummary" in event ? event.targetSummary : undefined)
    .filter((value): value is string => value !== undefined);
  const trajectoryTargets = context.trajectory?.events
    .map((event) => readString(event.data.targetSummary))
    .filter((value): value is string => value !== undefined) ?? [];
  return [...runtimeTargets, ...trajectoryTargets].join(", ");
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function trajectoryTextSummary(context: BenchmarkEvidenceContext): string {
  return context.trajectory?.events.map((event) => JSON.stringify(event.data)).join("\n") ?? "";
}
