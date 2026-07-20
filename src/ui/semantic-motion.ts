import type {
  SemanticMotionToken,
  TokenMotionDefinition,
  UiTokenContract,
} from "../contracts/ui-tokens.js";

export function semanticMotionForPhase(phase: string | undefined): SemanticMotionToken {
  switch (phase) {
    case "routing": return "routing";
    case "provider": return "waiting";
    case "finalizing": return "finalizing";
    case "background": return "background";
    case "tool": return "tool";
    case "worker": return "worker";
    case "thinking":
    default:
      return "thinking";
  }
}

export function semanticMotionDefinition(
  contract: UiTokenContract,
  token: SemanticMotionToken
): TokenMotionDefinition {
  return contract.motion[token];
}

export function semanticMotionFrameIndex(
  definition: TokenMotionDefinition,
  elapsedMs: number | undefined,
  phaseOffset = 0
): number {
  if (definition.frames.length === 0) return 0;
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs ?? 0) : 0;
  const cadence = Number.isFinite(definition.cadenceMs) && definition.cadenceMs > 0
    ? definition.cadenceMs
    : 1;
  const frame = Math.floor(elapsed / cadence) + Math.floor(phaseOffset);
  return ((frame % definition.frames.length) + definition.frames.length) % definition.frames.length;
}

export function semanticMotionFrame(
  definition: TokenMotionDefinition,
  elapsedMs: number | undefined,
  phaseOffset = 0
): string {
  return definition.frames[semanticMotionFrameIndex(definition, elapsedMs, phaseOffset)] ?? "";
}
