import type { ToolResult } from "./tool.js";

export type ToolCallPlanStatus =
  | "planned"
  | "invalid"
  | "executed"
  | "blocked"
  | "unavailable"
  | "cancelled";

export type ToolCallPlan = {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  source: "provider-tool-call" | "internal";
  status: ToolCallPlanStatus;
  raw?: unknown;
  error?: string;
  result?: ToolResult;
};

export type ProviderToolCallDelta = {
  index?: number;
  id?: string;
  name?: string;
  argumentsText?: string;
  raw?: unknown;
};
