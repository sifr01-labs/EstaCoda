import type { Trajectory, TrajectoryEventKind } from "./trajectory.js";

export type GoldenFlowAssertion =
  | { kind: "outcome-success"; expected: boolean }
  | { kind: "event-kind-present"; eventKind: TrajectoryEventKind }
  | { kind: "event-kind-absent"; eventKind: TrajectoryEventKind }
  | { kind: "summary-contains"; substring: string };

export type GoldenFlow = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  createdAt: string;
  trajectory: Trajectory;
  assertions: GoldenFlowAssertion[];
};
