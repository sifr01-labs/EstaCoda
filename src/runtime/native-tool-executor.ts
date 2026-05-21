import type { IntentRoute } from "../contracts/intent.js";
import type { RuntimeEventSink } from "../contracts/runtime-event.js";
import type { ToolCallPlan } from "../contracts/tool-plan.js";
import type { ToolExecutor, ToolExecutionRecord } from "../tools/tool-executor.js";
import { inferImageAspectRatio } from "../tools/image-tool-utils.js";
import { emit } from "../utils/runtime-helpers.js";
import type { RunRecorder } from "./run-recorder.js";
import type { SessionRuntimeContext } from "./session-runtime-context.js";

export class NativeToolExecutor {
  readonly #toolExecutor: ToolExecutor;
  readonly #runRecorder: RunRecorder;
  readonly #sessionId: string;
  readonly #sessionRuntimeContext: SessionRuntimeContext | undefined;

  constructor(options: {
    toolExecutor: ToolExecutor;
    runRecorder: RunRecorder;
    sessionId: string;
    sessionRuntimeContext?: SessionRuntimeContext;
  }) {
    this.#toolExecutor = options.toolExecutor;
    this.#runRecorder = options.runRecorder;
    this.#sessionId = options.sessionId;
    this.#sessionRuntimeContext = options.sessionRuntimeContext;
  }

  async executeDeterministicNativeTools(input: {
    intent: IntentRoute;
    text: string;
    trustedWorkspace: boolean;
    signal?: AbortSignal;
    onEvent?: RuntimeEventSink;
  }): Promise<{ executions: ToolExecutionRecord[]; plans: ToolCallPlan[] }> {
    if (input.intent.nativeIntent !== "image-generation") {
      return { executions: [], plans: [] };
    }

    const tool = this.#toolExecutor.getToolDefinition("image.generate");
    if (tool === undefined) {
      return { executions: [], plans: [] };
    }

    const plan: ToolCallPlan = {
      id: `native-image-${Date.now()}`,
      tool: "image.generate",
      input: {
        prompt: input.text,
        aspectRatio: inferImageAspectRatio(input.text)
      },
      source: "internal",
      status: "planned"
    };
    await this.#runRecorder.recordToolPlan(plan);
    await emit(input.onEvent, {
      kind: "tool-start",
      tool: plan.tool
    });

    const execution = await this.#toolExecutor.executeTool({
      tool: plan.tool,
      input: plan.input,
      trustedWorkspace: input.trustedWorkspace,
      sessionId: this.#currentSessionId(),
      signal: input.signal
    });

    if (execution === undefined) {
      plan.status = "unavailable";
      plan.error = `Tool is unavailable: ${plan.tool}`;
      await this.#runRecorder.recordToolPlan(plan);
      return { executions: [], plans: [plan] };
    }

    plan.status = execution.decision === "allow" && execution.result?.ok !== false
      ? "executed"
      : execution.decision === "allow"
        ? "invalid"
        : "blocked";
    plan.result = execution.result;
    plan.error = execution.result?.ok === false ? execution.result.content : undefined;
    await this.#runRecorder.recordToolPlan(plan);

    return { executions: [execution], plans: [plan] };
  }

  #currentSessionId(): string {
    return this.#sessionRuntimeContext?.currentSessionId() ?? this.#sessionId;
  }
}
