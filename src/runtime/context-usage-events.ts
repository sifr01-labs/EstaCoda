import type { ContextEstimateStage, RuntimeEventSink } from "../contracts/runtime-event.js";
import type { SessionContextWindowUsage } from "../contracts/session.js";
import { emit } from "../utils/runtime-helpers.js";

export async function emitContextEstimateEvents(
  sink: RuntimeEventSink | undefined,
  input: {
    filled: number;
    total: number;
    source: "live-estimate" | "assembled-prompt";
    stage: ContextEstimateStage;
  }
): Promise<void> {
  await emit(sink, {
    kind: "context-estimate",
    ...input
  });
  await emit(sink, {
    kind: "context-usage",
    filled: input.filled,
    total: input.total,
    source: input.source
  });
}

export async function emitContextWindowUsageEvents(
  sink: RuntimeEventSink | undefined,
  input: SessionContextWindowUsage
): Promise<void> {
  await emit(sink, {
    kind: "context-window-usage",
    ...input,
    source: "provider-actual"
  });
  await emit(sink, {
    kind: "context-usage",
    filled: input.usedTokens,
    total: input.totalTokens,
    source: "provider-actual"
  });
}
