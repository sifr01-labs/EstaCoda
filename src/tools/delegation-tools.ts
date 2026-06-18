import type { RegisteredTool, SessionToolProvider, ToolExecutionContext, ToolsetName } from "../contracts/tool.js";
import type { DelegateModelOverride, DelegateRole, DelegateTaskItem, DelegationConfig } from "../contracts/delegation.js";
import {
  MAX_DELEGATE_MODEL_OVERRIDE_ID_LENGTH,
  MAX_DELEGATE_PROVIDER_OVERRIDE_ID_LENGTH
} from "../contracts/delegation.js";
import type { BatchDelegationSummary, DelegationManager } from "../delegation/delegation-manager.js";
import { DEFAULT_DELEGATION_CONFIG } from "../config/delegation-defaults.js";

export type DelegationToolOptions = {
  manager: DelegationManager;
  parentSessionId: string | (() => string);
  profileId: string;
  trustedWorkspace: () => Promise<boolean> | boolean;
  delegationConfig?: DelegationConfig;
};

type DelegateTaskInput = {
  task?: string;
  tasks?: unknown;
  context?: string;
  allowedToolsets?: ToolsetName[];
  allowedTools?: string[];
  role?: DelegateRole;
  modelOverride?: DelegateModelOverride;
};

export function createDelegationTools(options: DelegationToolOptions): RegisteredTool[] {
  const delegationConfig = options.delegationConfig ?? DEFAULT_DELEGATION_CONFIG;
  return [
    {
      name: "delegate_task",
      description: [
        "Create isolated child sessions for bounded subtasks with explicit context and tool access.",
        `Supports one task or up to ${delegationConfig.maxBatchTasks} batch tasks.`,
        `Runs at most ${delegationConfig.maxConcurrentChildren} children in parallel.`,
        `Child delegation depth is limited to ${delegationConfig.maxSpawnDepth}.`
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "Single task text. Required when tasks is omitted."
          },
          tasks: {
            description: `Batch task objects. Maximum ${delegationConfig.maxBatchTasks}; execution concurrency is capped at ${delegationConfig.maxConcurrentChildren}.`,
            oneOf: [
              {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    task: { type: "string" },
                    context: { type: "string" },
                    allowedToolsets: { type: "array", items: { type: "string" } },
                    allowedTools: { type: "array", items: { type: "string" } },
                    role: { type: "string", enum: ["leaf", "orchestrator"] },
                    modelOverride: modelOverrideSchema()
                  },
                  required: ["task"]
                }
              },
              {
                type: "string",
                description: "Strict JSON array of task objects when JSON-string recovery is enabled."
              }
            ]
          },
          context: { type: "string" },
          allowedToolsets: {
            type: "array",
            items: { type: "string" }
          },
          allowedTools: {
            type: "array",
            items: { type: "string" }
          },
          role: {
            type: "string",
            enum: ["leaf", "orchestrator"]
          },
          modelOverride: modelOverrideSchema()
        }
      },
      riskClass: "shared-state-mutation",
      toolsets: ["core", "research", "coding"],
      progressLabel: "delegating task",
      maxResultSizeChars: 8000,
      isAvailable: () => true,
      run: async (input: DelegateTaskInput, context?: ToolExecutionContext) => {
        const parsed = parseDelegateTaskInput(input, delegationConfig);
        if (!parsed.ok) {
          return parsed.error;
        }

        const common = {
          parentSessionId: typeof options.parentSessionId === "function" ? options.parentSessionId() : options.parentSessionId,
          profileId: options.profileId,
          trustedWorkspace: await options.trustedWorkspace(),
          signal: context?.signal,
          onEvent: context?.onEvent
        };

        if (parsed.mode === "batch") {
          const summary = await options.manager.delegateBatch({
            ...common,
            tasks: parsed.tasks,
            recoveredTasksFromJsonString: parsed.recoveredTasksFromJsonString
          });

          return {
            ok: summary.status === "completed",
            content: renderBatchContent(summary),
            metadata: summary
          };
        }

        const summary = await options.manager.delegate({
          ...common,
          task: parsed.task,
          context: input.context,
          allowedToolsets: input.allowedToolsets,
          allowedTools: input.allowedTools,
          role: input.role ?? "leaf",
          modelOverride: parsed.modelOverride
        });

        return {
          ok: summary.status === "completed",
          content: [
            `Delegated to child session ${summary.childSessionId}.`,
            `Status: ${summary.status}`,
            summary.summary
          ].join("\n"),
          metadata: summary
        };
      }
    }
  ];
}

export const delegationToolProvider: SessionToolProvider = {
  name: "delegation",
  kind: "session",
  createTools(ctx) {
    return createDelegationTools({
      manager: requireProviderDependency("delegation", "delegationManager", ctx.delegationManager),
      parentSessionId: ctx.currentSessionId,
      profileId: ctx.profileId,
      trustedWorkspace: requireProviderDependency("delegation", "trustedWorkspace", ctx.trustedWorkspace),
      delegationConfig: ctx.delegationConfig
    });
  }
};

function requireProviderDependency<T>(provider: string, dependency: string, value: T | undefined): T {
  if (value === undefined) {
    throw new TypeError(`${provider}ToolProvider requires ${dependency}.`);
  }
  return value;
}

type ParsedDelegateTaskInput =
  | { ok: true; mode: "single"; task: string; modelOverride?: DelegateModelOverride }
  | { ok: true; mode: "batch"; tasks: DelegateTaskItem[]; recoveredTasksFromJsonString?: boolean }
  | { ok: false; error: { ok: false; content: string; metadata: Record<string, unknown> } };

function parseDelegateTaskInput(input: DelegateTaskInput, config: DelegationConfig): ParsedDelegateTaskInput {
  if (input.tasks !== undefined) {
    const recovered = recoverTasks(input.tasks, config);
    if (!recovered.ok) {
      return {
        ok: false,
        error: structuredValidationError(recovered.message, recovered.code)
      };
    }
    const normalized = normalizeTaskItems(recovered.tasks, input, config, recovered.recoveredTasksFromJsonString === true);
    if (!normalized.ok) {
      return {
        ok: false,
        error: structuredValidationError(normalized.message, normalized.code)
      };
    }
    return {
      ok: true,
      mode: "batch",
      tasks: normalized.tasks,
      recoveredTasksFromJsonString: recovered.recoveredTasksFromJsonString
    };
  }

  const task = input.task?.trim();
  if (task === undefined || task.length === 0) {
    return {
      ok: false,
      error: {
        ok: false,
        content: "delegate_task requires a non-empty task.",
        metadata: {
          reason: "validation-error",
          code: "missing-task"
        }
      }
    };
  }

  const modelOverride = normalizeModelOverride(input.modelOverride, "delegate_task modelOverride");
  if (!modelOverride.ok) {
    return {
      ok: false,
      error: structuredValidationError(modelOverride.message, modelOverride.code)
    };
  }

  return {
    ok: true,
    mode: "single",
    task,
    modelOverride: modelOverride.value
  };
}

function recoverTasks(value: unknown, config: DelegationConfig): {
  ok: true;
  tasks: unknown[];
  recoveredTasksFromJsonString?: boolean;
} | {
  ok: false;
  code: string;
  message: string;
} {
  if (typeof value === "string") {
    if (!config.recoverJsonStringTasks) {
      return {
        ok: false,
        code: "json-string-recovery-disabled",
        message: "delegate_task tasks must be an array; JSON-string task recovery is disabled."
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return {
        ok: false,
        code: "invalid-json-string",
        message: "delegate_task tasks string must be valid JSON."
      };
    }
    if (!Array.isArray(parsed)) {
      return {
        ok: false,
        code: "json-tasks-not-array",
        message: "delegate_task tasks JSON string must parse to an array."
      };
    }
    return {
      ok: true,
      tasks: parsed,
      recoveredTasksFromJsonString: true
    };
  }

  if (!Array.isArray(value)) {
    return {
      ok: false,
      code: "tasks-not-array",
      message: "delegate_task tasks must be an array of task objects."
    };
  }

  return {
    ok: true,
    tasks: value
  };
}

function normalizeTaskItems(
  rawTasks: unknown[],
  batchDefaults: DelegateTaskInput,
  config: DelegationConfig,
  strictUnknownFields: boolean
): { ok: true; tasks: DelegateTaskItem[] } | { ok: false; code: string; message: string } {
  if (rawTasks.length === 0) {
    return { ok: false, code: "empty-tasks", message: "delegate_task tasks must contain at least one task." };
  }
  if (rawTasks.length > config.maxBatchTasks) {
    return {
      ok: false,
      code: "too-many-tasks",
      message: `delegate_task received ${rawTasks.length} tasks, but maxBatchTasks is ${config.maxBatchTasks}.`
    };
  }
  const defaultsError = validateBatchDefaults(batchDefaults);
  if (defaultsError !== undefined) {
    return defaultsError;
  }

  const tasks: DelegateTaskItem[] = [];
  for (let index = 0; index < rawTasks.length; index += 1) {
    const raw = rawTasks[index];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, code: "invalid-task-object", message: `delegate_task tasks[${index}] must be an object.` };
    }
    const record = raw as Partial<DelegateTaskItem>;
    if (strictUnknownFields) {
      const unknownKeys = Object.keys(record).filter((key) => !TASK_ITEM_KEYS.has(key));
      if (unknownKeys.length > 0) {
        return {
          ok: false,
          code: "invalid-task-object",
          message: `delegate_task tasks[${index}] contains unknown fields: ${unknownKeys.join(", ")}.`
        };
      }
    }
    const task = typeof record.task === "string" ? record.task.trim() : "";
    if (task.length === 0) {
      return { ok: false, code: "empty-task-string", message: `delegate_task tasks[${index}].task must be non-empty.` };
    }
    if (record.context !== undefined && typeof record.context !== "string") {
      return { ok: false, code: "invalid-task-object", message: `delegate_task tasks[${index}].context must be a string.` };
    }
    if (record.allowedToolsets !== undefined && !isStringArray(record.allowedToolsets)) {
      return { ok: false, code: "invalid-task-object", message: `delegate_task tasks[${index}].allowedToolsets must be an array of strings.` };
    }
    if (record.allowedTools !== undefined && !isStringArray(record.allowedTools)) {
      return { ok: false, code: "invalid-task-object", message: `delegate_task tasks[${index}].allowedTools must be an array of strings.` };
    }
    if (record.role !== undefined && record.role !== "leaf" && record.role !== "orchestrator") {
      return { ok: false, code: "invalid-task-object", message: `delegate_task tasks[${index}].role must be leaf or orchestrator.` };
    }
    const modelOverride = normalizeModelOverride(record.modelOverride ?? batchDefaults.modelOverride, `delegate_task tasks[${index}].modelOverride`);
    if (!modelOverride.ok) {
      return { ok: false, code: modelOverride.code, message: modelOverride.message };
    }
    tasks.push({
      task,
      context: record.context ?? batchDefaults.context,
      allowedToolsets: record.allowedToolsets ?? batchDefaults.allowedToolsets,
      allowedTools: record.allowedTools ?? batchDefaults.allowedTools,
      role: record.role ?? batchDefaults.role ?? "leaf",
      modelOverride: modelOverride.value
    });
  }

  return { ok: true, tasks };
}

const TASK_ITEM_KEYS = new Set(["task", "context", "allowedToolsets", "allowedTools", "role", "modelOverride"]);

function validateBatchDefaults(input: DelegateTaskInput): { ok: false; code: string; message: string } | undefined {
  if (input.context !== undefined && typeof input.context !== "string") {
    return { ok: false, code: "invalid-batch-default", message: "delegate_task context must be a string." };
  }
  if (input.allowedToolsets !== undefined && !isStringArray(input.allowedToolsets)) {
    return { ok: false, code: "invalid-batch-default", message: "delegate_task allowedToolsets must be an array of strings." };
  }
  if (input.allowedTools !== undefined && !isStringArray(input.allowedTools)) {
    return { ok: false, code: "invalid-batch-default", message: "delegate_task allowedTools must be an array of strings." };
  }
  if (input.role !== undefined && input.role !== "leaf" && input.role !== "orchestrator") {
    return { ok: false, code: "invalid-batch-default", message: "delegate_task role must be leaf or orchestrator." };
  }
  const modelOverride = normalizeModelOverride(input.modelOverride, "delegate_task modelOverride");
  if (!modelOverride.ok) {
    return { ok: false, code: modelOverride.code, message: modelOverride.message };
  }
  return undefined;
}

function normalizeModelOverride(
  value: unknown,
  path: string
): { ok: true; value?: DelegateModelOverride } | { ok: false; code: string; message: string } {
  if (value === undefined) {
    return { ok: true };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, code: "invalid-model-override", message: `${path} must be an object with a model string.` };
  }
  const record = value as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => key !== "model" && key !== "provider");
  if (unknownKeys.length > 0) {
    return { ok: false, code: "invalid-model-override", message: `${path} contains unknown fields: ${unknownKeys.join(", ")}.` };
  }
  if (typeof record.model !== "string" || record.model.trim().length === 0) {
    return { ok: false, code: "invalid-model-override", message: `${path}.model must be a non-empty string.` };
  }
  const model = record.model.trim();
  if (model.length > MAX_DELEGATE_MODEL_OVERRIDE_ID_LENGTH) {
    return {
      ok: false,
      code: "invalid-model-override",
      message: `${path}.model must be ${MAX_DELEGATE_MODEL_OVERRIDE_ID_LENGTH} characters or fewer.`
    };
  }
  if (record.provider !== undefined && (typeof record.provider !== "string" || record.provider.trim().length === 0)) {
    return { ok: false, code: "invalid-model-override", message: `${path}.provider must be a non-empty string when provided.` };
  }
  const provider = typeof record.provider === "string" ? record.provider.trim() : undefined;
  if (provider !== undefined && provider.length > MAX_DELEGATE_PROVIDER_OVERRIDE_ID_LENGTH) {
    return {
      ok: false,
      code: "invalid-model-override",
      message: `${path}.provider must be ${MAX_DELEGATE_PROVIDER_OVERRIDE_ID_LENGTH} characters or fewer.`
    };
  }
  return {
    ok: true,
    value: {
      model,
      provider
    }
  };
}

function modelOverrideSchema() {
  return {
    type: "object",
    description: "Optional child model override. Omit provider for the parent provider, or supply a configured runnable provider for a reviewed cross-provider override.",
    properties: {
      model: { type: "string", maxLength: MAX_DELEGATE_MODEL_OVERRIDE_ID_LENGTH },
      provider: { type: "string", maxLength: MAX_DELEGATE_PROVIDER_OVERRIDE_ID_LENGTH }
    },
    required: ["model"],
    additionalProperties: false
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function structuredValidationError(message: string, code: string): { ok: false; content: string; metadata: Record<string, unknown> } {
  return {
    ok: false,
    content: message,
    metadata: {
      reason: "validation-error",
      code
    }
  };
}

function renderBatchContent(summary: BatchDelegationSummary): string {
  return [
    `Delegated batch ${summary.batchId}.`,
    `Status: ${summary.status}`,
    summary.summary,
    ...summary.results.map((result) =>
      `${result.index + 1}. ${result.childStatus}: ${result.summary.slice(0, 240)}`
    )
  ].join("\n");
}
