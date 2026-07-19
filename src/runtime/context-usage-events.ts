import type { ContextEstimateStage, RuntimeEventSink } from "../contracts/runtime-event.js";
import type { SessionContextWindowUsage } from "../contracts/session.js";
import { emit } from "../utils/runtime-helpers.js";

export async function emitContextEstimate(
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
}

export async function emitContextWindowUsage(
  sink: RuntimeEventSink | undefined,
  input: SessionContextWindowUsage
): Promise<void> {
  await emit(sink, {
    kind: "context-window-usage",
    ...input,
    source: "provider-actual"
  });
}
