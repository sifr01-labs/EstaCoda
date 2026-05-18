import type { EnvironmentType } from "./security.js";

export type ToolRiskClass =
  | "read-only-local"
  | "read-only-network"
  | "workspace-write"
  | "external-side-effect"
  | "credential-access"
  | "destructive-local"
  | "shared-state-mutation"
  | "spend-money"
  | "sandbox-escape";

export type ToolsetName =
  | "core"
  | "files"
  | "shell-readonly"
  | "shell-write"
  | "web"
  | "browser"
  | "telegram"
  | "media"
  | "coding"
  | "research"
  | "memory"
  | "mcp"
  | "dangerous"
  | (string & {});

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: unknown;
  riskClass: ToolRiskClass;
  toolsets: ToolsetName[];
  progressLabel: string;
  maxResultSizeChars: number;
  requiredConfig?: string[];
};

export type ToolResult = {
  ok: boolean;
  content: string;
  metadata?: Record<string, unknown>;
};

export type ToolExecutionContext = {
  signal?: AbortSignal;
  environmentType?: EnvironmentType;
};

export type ToolHandler<TInput = unknown> = (input: TInput, context?: ToolExecutionContext) => Promise<ToolResult>;

export type RegisteredTool<TInput = any> = ToolDefinition & {
  isAvailable(): Promise<boolean> | boolean;
  run: ToolHandler<TInput>;
};
