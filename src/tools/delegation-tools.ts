import type { RegisteredTool, SessionToolProvider, ToolExecutionContext, ToolsetName } from "../contracts/tool.js";
import type {
  DelegateModelOverride,
  DelegateRole,
  DelegateSynthesis,
  DelegateTaskItem,
  DelegationConfig
} from "../contracts/delegation.js";
import {
  DELEGATE_TASK_MAX_RESULT_CHARS,
  MAX_DELEGATION_BATCH_TASKS,
  MAX_DELEGATE_MODEL_OVERRIDE_ID_LENGTH,
  MAX_DELEGATE_PROVIDER_OVERRIDE_ID_LENGTH
} from "../contracts/delegation.js";
import type { DurableDelegationService } from "../delegation/durable-delegation-service.js";
import { DEFAULT_DELEGATION_CONFIG } from "../config/delegation-defaults.js";

export type DelegationToolOptions = {
  service: DurableDelegationService;
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
  synthesis?: unknown;
};

export function createDelegationTools(options: DelegationToolOptions): RegisteredTool[] {
  const configuredDelegation = options.delegationConfig ?? DEFAULT_DELEGATION_CONFIG;
  const delegationConfig = {
    ...configuredDelegation,
    maxBatchTasks: Math.max(1, Math.min(configuredDelegation.maxBatchTasks, MAX_DELEGATION_BATCH_TASKS))
  };
  return [
    {
      name: "delegate_task",
      description: [
        "Create durable background Tasks for bounded subtasks with explicit context and tool access.",
        "Returns a Task handle immediately; use Task status and result surfaces to follow completion.",
        `Supports one task or up to ${delegationConfig.maxBatchTasks} batch tasks.`,
        "An optional synthesis objective adds one fixed terminal Step after every worker.",
        `The durable scheduler runs at most ${delegationConfig.maxConcurrentChildren} Steps in parallel.`,
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
          modelOverride: modelOverrideSchema(),
          synthesis: {
            type: "object",
            additionalProperties: false,
            properties: {
              objective: { type: "string", minLength: 1 },
              modelOverride: modelOverrideSchema()
            },
            required: ["objective"]
          }
        }
      },
      riskClass: "shared-state-mutation",
      toolsets: ["core", "research", "coding"],
      progressLabel: "delegating task",
      maxResultSizeChars: DELEGATE_TASK_MAX_RESULT_CHARS,
      isAvailable: () => true,
      run: async (input: DelegateTaskInput, context?: ToolExecutionContext) => {
        const parsed = parseDelegateTaskInput(input, delegationConfig);
        if (!parsed.ok) {
          return parsed.error;
        }
        if (context?.toolCallId === undefined) {
          return structuredValidationError(
            "delegate_task requires a stable provider tool call ID for idempotent Task creation.",
            "missing-tool-call-id"
          );
        }
        const tasks: DelegateTaskItem[] = parsed.mode === "batch" ? parsed.tasks : [{
          task: parsed.task,
          context: input.context,
          allowedToolsets: input.allowedToolsets,
          allowedTools: input.allowedTools,
          role: input.role ?? "leaf",
          modelOverride: parsed.modelOverride
        }];
        const handle = options.service.create({
          toolCallId: context.toolCallId,
          tasks,
          ...(parsed.synthesis === undefined ? {} : { synthesis: parsed.synthesis }),
          trustedWorkspace: await options.trustedWorkspace(),
          ...(parsed.mode === "batch" && parsed.recoveredTasksFromJsonString === true
            ? { recoveredTasksFromJsonString: true }
            : {})
        });
        return {
          ok: true,
          content: [
            `Created durable Task ${handle.taskId}.`,
            `Status: ${handle.status}`,
            `Steps: ${handle.stepCount}`,
            ...(handle.synthesisStepId === undefined ? [] : [
              `Workers: ${handle.workerStepIds.length}`,
              `Synthesis Step: ${handle.synthesisStepId}`
            ]),
            handle.childTask ? `Parent Task: ${handle.parentTaskId}` : "Task will continue independently of this turn."
          ].join("\n"),
          metadata: handle
        };
      }
    }
  ];
}

export const delegationToolProvider: SessionToolProvider = {
  name: "delegation",
  kind: "session",
  createTools(ctx) {
    if (ctx.delegationService === undefined) return [];
    return createDelegationTools({
      service: ctx.delegationService,
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
  | { ok: true; mode: "single"; task: string; modelOverride?: DelegateModelOverride; synthesis?: DelegateSynthesis }
  | { ok: true; mode: "batch"; tasks: DelegateTaskItem[]; synthesis?: DelegateSynthesis; recoveredTasksFromJsonString?: boolean }
  | { ok: false; error: { ok: false; content: string; metadata: Record<string, unknown> } };

function parseDelegateTaskInput(input: DelegateTaskInput, config: DelegationConfig): ParsedDelegateTaskInput {
  const synthesis = normalizeSynthesis(input.synthesis);
  if (!synthesis.ok) {
    return { ok: false, error: structuredValidationError(synthesis.message, synthesis.code) };
  }
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
      synthesis: synthesis.value,
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
    modelOverride: modelOverride.value,
    synthesis: synthesis.value
  };
}

function normalizeSynthesis(
  value: unknown
): { ok: true; value?: DelegateSynthesis } | { ok: false; code: string; message: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, code: "invalid-synthesis", message: "delegate_task synthesis must be an object." };
  }
  const record = value as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => key !== "objective" && key !== "modelOverride");
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      code: "invalid-synthesis",
      message: `delegate_task synthesis contains unknown fields: ${unknownKeys.join(", ")}.`
    };
  }
  if (typeof record.objective !== "string" || record.objective.trim().length === 0) {
    return { ok: false, code: "invalid-synthesis", message: "delegate_task synthesis.objective must be non-empty." };
  }
  const modelOverride = normalizeModelOverride(record.modelOverride, "delegate_task synthesis.modelOverride");
  if (!modelOverride.ok) return modelOverride;
  return {
    ok: true,
    value: {
      objective: record.objective.trim(),
      ...(modelOverride.value === undefined ? {} : { modelOverride: modelOverride.value })
    }
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
