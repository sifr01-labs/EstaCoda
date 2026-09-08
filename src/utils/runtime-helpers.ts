import type { RuntimeEvent, RuntimeEventSink } from "../contracts/runtime-event.js";
import type { AgentCancellationSource } from "../contracts/session.js";

export async function emit(sink: RuntimeEventSink | undefined, event: RuntimeEvent): Promise<void> {
  await sink?.(event);
}

export function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/** Return a bounded, non-sensitive source for an aborted parent turn signal. */
export function abortSourceFromSignal(signal: AbortSignal | undefined): AgentCancellationSource | undefined {
  if (signal?.aborted !== true) {
    return undefined;
  }

  switch (signal.reason) {
    case "interrupt":
      return "interrupt";
    case "stop":
    case "channel-stop":
      return "stop";
    case "drain-timeout":
      return "drain-timeout";
    case "stuck-loop":
      return "stuck-loop";
    default:
      return "unknown";
  }
}
