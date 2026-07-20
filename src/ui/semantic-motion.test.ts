import { describe, expect, it } from "vitest";
import { resolveTokens } from "../theme/token-resolver.js";
import {
  semanticMotionForPhase,
  semanticMotionFrame,
  semanticMotionFrameIndex,
} from "./semantic-motion.js";

describe("semantic motion", () => {
  it("maps runtime phases onto the seven semantic tokens", () => {
    expect(semanticMotionForPhase("thinking")).toBe("thinking");
    expect(semanticMotionForPhase("routing")).toBe("routing");
    expect(semanticMotionForPhase("provider")).toBe("waiting");
    expect(semanticMotionForPhase("tool")).toBe("tool");
    expect(semanticMotionForPhase("worker")).toBe("worker");
    expect(semanticMotionForPhase("finalizing")).toBe("finalizing");
    expect(semanticMotionForPhase("background")).toBe("background");
  });

  it("uses elapsed time and each token's cadence", () => {
    const token = resolveTokens("standard", "dark").contract.motion.thinking;
    expect(semanticMotionFrame(token, 0)).toBe("◜");
    expect(semanticMotionFrame(token, 119)).toBe("◜");
    expect(semanticMotionFrame(token, 120)).toBe("◠");
  });

  it("supports stable phase offsets for workers", () => {
    const token = resolveTokens("standard", "dark").contract.motion.worker;
    expect(semanticMotionFrameIndex(token, 0, 2)).toBe(2);
    expect(semanticMotionFrame(token, 0, 2)).toBe("•");
  });
});
