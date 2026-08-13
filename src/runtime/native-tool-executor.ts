import type { ChannelAttachment } from "../contracts/channel.js";
import type { IntentRoute } from "../contracts/intent.js";
import type { ProviderUsageLineage } from "../contracts/provider-usage.js";
import type { RuntimeEventSink } from "../contracts/runtime-event.js";
import type { ToolCallPlan } from "../contracts/tool-plan.js";
import type { VisionInputProvenanceContext } from "../contracts/vision.js";
import type { ToolApprovalHandler } from "../contracts/tool.js";
import type { ToolExecutor, ToolExecutionRecord } from "../tools/tool-executor.js";
import { summarizeSecurityTarget } from "../tools/tool-executor.js";
import { buildToolDisplayPreview } from "../tools/tool-target-summary.js";
import { inferImageAspectRatio } from "../tools/image-tool-utils.js";
import { emit } from "../utils/runtime-helpers.js";
import { toolResultFileChangePreview, toolResultStats } from "./tool-plan-runner.js";
import type { RunRecorder } from "./run-recorder.js";
import type { SessionRuntimeContext } from "./session-runtime-context.js";
import {
  markVisionAttachmentHandled,
  setEphemeralVisionDelivery
} from "../vision/ephemeral-vision-content.js";

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
    attachments?: ChannelAttachment[];
    trustedWorkspace: boolean;
    visibleTurnId?: string;
    providerUsageLineage?: ProviderUsageLineage;
    visionInputProvenance?: VisionInputProvenanceContext;
    signal?: AbortSignal;
    onEvent?: RuntimeEventSink;
    onApprovalRequest?: ToolApprovalHandler;
  }): Promise<{ executions: ToolExecutionRecord[]; plans: ToolCallPlan[] }> {
    if (input.intent.nativeIntent === "attachment-analysis") {
      return await this.#executeInitialVisionAttachments(input);
    }

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
      tool: plan.tool,
      targetSummary: summarizeSecurityTarget(plan.tool, plan.input),
      displayPreview: buildToolDisplayPreview(plan.tool, plan.input),
      activityId: plan.id
    });

    const execution = await this.#toolExecutor.executeTool({
      tool: plan.tool,
      input: plan.input,
      trustedWorkspace: input.trustedWorkspace,
      sessionId: this.#currentSessionId(),
      toolCallId: plan.id,
      visibleTurnId: input.visibleTurnId,
      providerUsageLineage: input.providerUsageLineage,
      visionInputProvenance: input.visionInputProvenance,
      signal: input.signal,
      onEvent: input.onEvent,
      onApprovalRequest: input.onApprovalRequest
    });

    if (execution === undefined) {
      plan.status = "unavailable";
      plan.error = `Tool is unavailable: ${plan.tool}`;
      await this.#runRecorder.recordToolPlan(plan);
      await emit(input.onEvent, {
        kind: "tool-result",
        tool: plan.tool,
        ok: false,
        targetSummary: summarizeSecurityTarget(plan.tool, plan.input),
        displayPreview: buildToolDisplayPreview(plan.tool, plan.input),
        activityId: plan.id
      });
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
    await emit(input.onEvent, {
      kind: "tool-result",
      tool: execution.tool.name,
      decision: execution.decision,
      riskClass: execution.riskClass,
      ok: execution.result?.ok,
      fileChangePreview: toolResultFileChangePreview(execution),
      targetSummary: execution.targetSummary,
      displayPreview: buildToolDisplayPreview(plan.tool, plan.input),
      activityId: plan.id,
      ...toolResultStats(execution)
    });

    return { executions: [execution], plans: [plan] };
  }

  async #executeInitialVisionAttachments(input: {
    text: string;
    attachments?: ChannelAttachment[];
    trustedWorkspace: boolean;
    visibleTurnId?: string;
    providerUsageLineage?: ProviderUsageLineage;
    visionInputProvenance?: VisionInputProvenanceContext;
    signal?: AbortSignal;
    onEvent?: RuntimeEventSink;
    onApprovalRequest?: ToolApprovalHandler;
  }): Promise<{ executions: ToolExecutionRecord[]; plans: ToolCallPlan[] }> {
    if (this.#toolExecutor.getToolDefinition("vision.analyze") === undefined) {
      return { executions: [], plans: [] };
    }

    const attachments = (input.attachments ?? []).filter(isReadyImageAttachment);
    if (attachments.length === 0) return { executions: [], plans: [] };
    const paths = attachments
      .map((attachment) => attachment.localPath ?? attachment.path)
      .filter((path): path is string => path !== undefined);
    if (paths.length === 0) return { executions: [], plans: [] };
    const executions: ToolExecutionRecord[] = [];
    const plans: ToolCallPlan[] = [];
    const plan: ToolCallPlan = {
      id: `native-vision-${Date.now()}`,
      tool: "vision.analyze",
      input: paths.length === 1
        ? { path: paths[0], prompt: input.text }
        : { paths, prompt: input.text },
      source: "internal",
      status: "planned"
    };
    plans.push(plan);
    await this.#runRecorder.recordToolPlan(plan);
    await emit(input.onEvent, {
      kind: "tool-start",
      tool: plan.tool,
      targetSummary: summarizeSecurityTarget(plan.tool, plan.input),
      displayPreview: buildToolDisplayPreview(plan.tool, plan.input),
      activityId: plan.id
    });

    const execution = await this.#toolExecutor.executeTool({
      tool: plan.tool,
      input: plan.input,
      trustedWorkspace: input.trustedWorkspace,
      sessionId: this.#currentSessionId(),
      toolCallId: plan.id,
      visibleTurnId: input.visibleTurnId,
      providerUsageLineage: input.providerUsageLineage,
      visionInputProvenance: input.visionInputProvenance,
      visionDispatchPhase: "initial-attachment",
      signal: input.signal,
      onEvent: input.onEvent,
      onApprovalRequest: input.onApprovalRequest
    });

    if (execution === undefined) {
      plan.status = "unavailable";
      plan.error = `Tool is unavailable: ${plan.tool}`;
    } else {
      plan.status = execution.decision === "allow" && execution.result?.ok !== false
        ? "executed"
        : execution.decision === "allow"
          ? "invalid"
          : "blocked";
      plan.result = execution.result;
      plan.error = execution.result?.ok === false ? execution.result.content : undefined;
      setEphemeralVisionDelivery(execution.result, "initial");
      for (const attachment of attachments) markVisionAttachmentHandled(execution.result, attachment.id);
      executions.push(execution);
    }

    await this.#runRecorder.recordToolPlan(plan);
    await emit(input.onEvent, {
      kind: "tool-result",
      tool: execution?.tool.name ?? plan.tool,
      decision: execution?.decision,
      riskClass: execution?.riskClass,
      ok: execution?.result?.ok ?? false,
      targetSummary: execution?.targetSummary ?? summarizeSecurityTarget(plan.tool, plan.input),
      displayPreview: buildToolDisplayPreview(plan.tool, plan.input),
      activityId: plan.id,
      ...(execution === undefined ? {} : toolResultStats(execution))
    });

    return { executions, plans };
  }

  #currentSessionId(): string {
    return this.#sessionRuntimeContext?.currentSessionId() ?? this.#sessionId;
  }
}

function isReadyImageAttachment(attachment: ChannelAttachment): boolean {
  return (attachment.status === undefined || attachment.status === "ready") &&
    (attachment.kind === "image" || attachment.mimeType?.toLowerCase().startsWith("image/") === true) &&
    typeof (attachment.localPath ?? attachment.path) === "string";
}
