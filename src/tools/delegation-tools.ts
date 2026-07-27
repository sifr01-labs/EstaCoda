import type { RegisteredTool, SessionToolProvider, ToolExecutionContext, ToolsetName } from "../contracts/tool.js";
import type {
  DelegateModelOverride,
  DelegateRole,
  DelegateSynthesis,
  DelegateTaskItem,
  DelegationConfig,
  DelegationResearchContract
} from "../contracts/delegation.js";
import {
  DELEGATE_TASK_MAX_RESULT_CHARS,
  MAX_DELEGATION_BATCH_TASKS,
  MAX_DELEGATE_MODEL_OVERRIDE_ID_LENGTH,
  MAX_DELEGATE_PROVIDER_OVERRIDE_ID_LENGTH,
  MAX_DELEGATE_RESEARCH_SCOPE_LENGTH
} from "../contracts/delegation.js";
import {
  DelegationAccessError,
  DelegationResearchContractError,
  type DurableDelegationHandle,
  type DurableDelegationService
} from "../delegation/durable-delegation-service.js";
import type { TaskExecutionPreference } from "../contracts/task.js";
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
  research?: unknown;
  synthesis?: unknown;
  executionPreference?: TaskExecutionPreference;
  spendingLimit?: unknown;
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
        "Create durable Tasks for bounded subtasks with explicit context and tool access.",
        "Returns a Task handle immediately; use Task status and result surfaces to follow completion.",
        `Supports one task or up to ${delegationConfig.maxBatchTasks} batch tasks.`,
        "Batches add one fixed terminal synthesis Step by default; pass synthesis: false only for inspection-only work.",
        "A synthesis object can provide a custom final-answer objective and model.",
        "A non-terminal root Task with a primary Result Step owns the requested answer: this provider turn ends after creation and the durable result is delivered when the Task settles.",
        "Research items should use distinct non-overlapping scopes; live and repository evidence requirements are verified from observed tool results, not model claims.",
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
                    allowedTools: delegatedAllowedToolsSchema(),
                    role: { type: "string", enum: ["leaf", "orchestrator"] },
                    modelOverride: modelOverrideSchema(),
                    research: researchContractSchema()
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
            items: { type: "string" },
            description: delegatedAllowedToolsDescription()
          },
          role: {
            type: "string",
            enum: ["leaf", "orchestrator"]
          },
          modelOverride: modelOverrideSchema(),
          research: researchContractSchema(),
          synthesis: {
            description: "Batch default: synthesize all worker Results into one final answer. Use false only when no combined answer should be produced.",
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  objective: { type: "string", minLength: 1 },
                  modelOverride: modelOverrideSchema()
                },
                required: ["objective"]
              },
              { type: "boolean", const: false }
            ]
          },
          executionPreference: {
            type: "string",
            enum: ["auto", "background"],
            description: "auto starts in the interactive host when available; background sends the Task directly to the gateway."
          },
          spendingLimit: {
            type: "object",
            additionalProperties: false,
            properties: {
              maxEstimatedCostUsd: { type: "number", minimum: 0 }
            },
            required: ["maxEstimatedCostUsd"],
            description: "Optional estimated-cost ceiling for this root Task. It may narrow, but never widen, the configured default."
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
          modelOverride: parsed.modelOverride,
          ...(parsed.research === undefined ? {} : { research: parsed.research })
        }];
        let handle: DurableDelegationHandle;
        try {
          handle = await options.service.createAndActivate({
            toolCallId: context.toolCallId,
            ...(context.visibleTurnId === undefined ? {} : { originTurnId: context.visibleTurnId }),
            tasks,
            ...(parsed.synthesis === undefined ? {} : { synthesis: parsed.synthesis }),
            trustedWorkspace: await options.trustedWorkspace(),
            executionPreference: input.executionPreference,
            ...(parsed.spendingLimit === undefined ? {} : { spendingLimit: parsed.spendingLimit }),
            ...(parsed.mode === "batch" && parsed.recoveredTasksFromJsonString === true
              ? { recoveredTasksFromJsonString: true }
              : {})
          });
        } catch (error) {
          if (error instanceof DelegationResearchContractError) {
            return structuredValidationError(
              error.taskIndex === undefined
                ? error.message
                : `delegate_task tasks[${error.taskIndex}]: ${error.message}`,
              error.code
            );
          }
          if (error instanceof DelegationAccessError) {
            return {
              ok: false,
              content: error.taskIndex === undefined
                ? error.message
                : `delegate_task tasks[${error.taskIndex}]: ${error.message}`,
              metadata: {
                reason: "delegation-access-error",
                code: error.code,
                ...(error.taskIndex === undefined ? {} : { taskIndex: error.taskIndex }),
                access: error.access
              }
            };
          }
          throw error;
        }
        const settled = ["completed", "partial", "failed", "cancelled"].includes(handle.status);
        return {
          ok: true,
          content: [
            `Created durable Task ${handle.taskId}.`,
            `Status: ${handle.status}`,
            `Execution: ${settled ? "settled" : handle.execution}`,
            `Execution preference: ${handle.executionPreference}`,
            `Background continuation: ${handle.backgroundContinuation}`,
            ...(handle.activationFailure === undefined ? [] : [
              "Foreground activation failed after durable Task creation; use this Task handle to inspect or resume it."
            ]),
            ...(handle.executionWaitingReason === undefined ? [] : [`Waiting reason: ${handle.executionWaitingReason}`]),
            `Steps: ${handle.stepCount}`,
            ...(handle.synthesisStepId === undefined ? [] : [
              `Workers: ${handle.workerStepIds.length}`,
              `Synthesis Step: ${handle.synthesisStepId}`
            ]),
            handle.childTask
              ? `Parent Task: ${handle.parentTaskId}`
              : settled
                ? "Task is settled and its durable results are available through Task result surfaces."
                : handle.execution === "foreground"
                  ? "Task is running in this session and its progress is durable."
                  : handle.backgroundContinuation === "available"
                    ? "Task is durable and available for background continuation."
                    : "Task is durable, but no active background continuation was detected."
          ].join("\n"),
          metadata: handle
        };
      }
    }
  ];
}

function delegatedAllowedToolsSchema(): Record<string, unknown> {
  return {
    type: "array",
    items: { type: "string" },
    description: delegatedAllowedToolsDescription()
  };
}

function delegatedAllowedToolsDescription(): string {
  return [
    "Optional exact child-tool allowlist.",
    "Use provider-visible tool names from this turn, such as file_read or web_search.",
    "EstaCoda resolves those aliases to canonical internal tool IDs before admission; unknown names fail closed."
  ].join(" ");
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

type ParsedSpendingLimit = { maxEstimatedCostUsd: number };

type ParsedDelegateTaskInput =
  | { ok: true; mode: "single"; task: string; modelOverride?: DelegateModelOverride; research?: DelegationResearchContract; synthesis?: DelegateSynthesis | false; spendingLimit?: ParsedSpendingLimit }
  | { ok: true; mode: "batch"; tasks: DelegateTaskItem[]; synthesis?: DelegateSynthesis | false; spendingLimit?: ParsedSpendingLimit; recoveredTasksFromJsonString?: boolean }
  | { ok: false; error: { ok: false; content: string; metadata: Record<string, unknown> } };

function parseDelegateTaskInput(input: DelegateTaskInput, config: DelegationConfig): ParsedDelegateTaskInput {
  if (input.executionPreference !== undefined && input.executionPreference !== "auto" && input.executionPreference !== "background") {
    return {
      ok: false,
      error: structuredValidationError(
        "delegate_task executionPreference must be auto or background.",
        "invalid-execution-preference"
      )
    };
  }
  const spendingLimit = normalizeSpendingLimit(input.spendingLimit);
  if (!spendingLimit.ok) {
    return { ok: false, error: structuredValidationError(spendingLimit.message, spendingLimit.code) };
  }
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
      spendingLimit: spendingLimit.value,
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
  const research = normalizeResearchContract(input.research, "delegate_task research");
  if (!research.ok) {
    return {
      ok: false,
      error: structuredValidationError(research.message, research.code)
    };
  }

  return {
    ok: true,
    mode: "single",
    task,
    modelOverride: modelOverride.value,
    research: research.value,
    synthesis: synthesis.value,
    spendingLimit: spendingLimit.value
  };
}

function normalizeSpendingLimit(
  value: unknown
): { ok: true; value?: ParsedSpendingLimit } | { ok: false; code: string; message: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, code: "invalid-spending-limit", message: "delegate_task spendingLimit must be an object." };
  }
  const record = value as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => key !== "maxEstimatedCostUsd");
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      code: "invalid-spending-limit",
      message: `delegate_task spendingLimit contains unknown fields: ${unknownKeys.join(", ")}.`
    };
  }
  if (typeof record.maxEstimatedCostUsd !== "number" ||
      !Number.isFinite(record.maxEstimatedCostUsd) || record.maxEstimatedCostUsd < 0) {
    return {
      ok: false,
      code: "invalid-spending-limit",
      message: "delegate_task spendingLimit.maxEstimatedCostUsd must be a finite non-negative number."
    };
  }
  return { ok: true, value: { maxEstimatedCostUsd: record.maxEstimatedCostUsd } };
}

function normalizeSynthesis(
  value: unknown
): { ok: true; value?: DelegateSynthesis | false } | { ok: false; code: string; message: string } {
  if (value === undefined) return { ok: true };
  if (value === false) return { ok: true, value: false };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, code: "invalid-synthesis", message: "delegate_task synthesis must be an object or false." };
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
    const research = normalizeResearchContract(record.research, `delegate_task tasks[${index}].research`);
    if (!research.ok) {
      return { ok: false, code: research.code, message: research.message };
    }
    tasks.push({
      task,
      context: record.context ?? batchDefaults.context,
      allowedToolsets: record.allowedToolsets ?? batchDefaults.allowedToolsets,
      allowedTools: record.allowedTools ?? batchDefaults.allowedTools,
      role: record.role ?? batchDefaults.role ?? "leaf",
      modelOverride: modelOverride.value,
      research: research.value
    });
  }

  const seenScopes = new Set<string>();
  for (let index = 0; index < tasks.length; index += 1) {
    const scope = tasks[index]?.research?.scope;
    if (scope === undefined) continue;
    if (seenScopes.has(scope)) {
      return {
        ok: false,
        code: "duplicate-research-scope",
        message: `delegate_task tasks[${index}].research.scope duplicates another normalized research scope.`
      };
    }
    seenScopes.add(scope);
  }

  return { ok: true, tasks };
}

const TASK_ITEM_KEYS = new Set(["task", "context", "allowedToolsets", "allowedTools", "role", "modelOverride", "research"]);

function validateBatchDefaults(input: DelegateTaskInput): { ok: false; code: string; message: string } | undefined {
  if (input.research !== undefined) {
    return {
      ok: false,
      code: "invalid-research-contract",
      message: "delegate_task research must be declared on each item when tasks is a batch."
    };
  }
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

function normalizeResearchContract(
  value: unknown,
  path: string
): { ok: true; value?: DelegationResearchContract } | { ok: false; code: string; message: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, code: "invalid-research-contract", message: `${path} must be an object.` };
  }
  const record = value as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) =>
    key !== "scope" && key !== "requireLiveSources" && key !== "requireRepositoryEvidence"
  );
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      code: "invalid-research-contract",
      message: `${path} contains unknown fields: ${unknownKeys.join(", ")}.`
    };
  }
  if (typeof record.scope !== "string") {
    return { ok: false, code: "invalid-research-contract", message: `${path}.scope must be a non-empty string.` };
  }
  const scope = normalizeResearchScope(record.scope);
  if (scope.length === 0 || scope.length > MAX_DELEGATE_RESEARCH_SCOPE_LENGTH || /[\u0000-\u001F\u007F]/u.test(scope)) {
    return {
      ok: false,
      code: "invalid-research-contract",
      message: `${path}.scope must be 1-${MAX_DELEGATE_RESEARCH_SCOPE_LENGTH} bounded characters.`
    };
  }
  if (record.requireLiveSources !== undefined && typeof record.requireLiveSources !== "boolean") {
    return { ok: false, code: "invalid-research-contract", message: `${path}.requireLiveSources must be boolean.` };
  }
  if (record.requireRepositoryEvidence !== undefined && typeof record.requireRepositoryEvidence !== "boolean") {
    return { ok: false, code: "invalid-research-contract", message: `${path}.requireRepositoryEvidence must be boolean.` };
  }
  return {
    ok: true,
    value: {
      scope,
      requireLiveSources: record.requireLiveSources === true,
      requireRepositoryEvidence: record.requireRepositoryEvidence === true
    }
  };
}

function normalizeResearchScope(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
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

function researchContractSchema() {
  return {
    type: "object",
    description: "Optional durable evidence contract. Batch scopes must be unique after normalization.",
    properties: {
      scope: { type: "string", minLength: 1, maxLength: MAX_DELEGATE_RESEARCH_SCOPE_LENGTH },
      requireLiveSources: { type: "boolean" },
      requireRepositoryEvidence: { type: "boolean" }
    },
    required: ["scope"],
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
