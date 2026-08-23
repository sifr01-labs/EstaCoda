import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import type { ProviderRequest } from "../contracts/provider.js";
import { estimateProviderRequestAccounting } from "./provider-request-accounting.js";
import { CHARS_PER_TOKEN, estimateMessagesTokensRough } from "./token-estimator.js";

const protectedFixtureValue = "synthetic-protected-fixture-value-1234567890";

function fixtureRequest(toolCount = 1): Pick<ProviderRequest, "messages" | "tools"> {
  return {
    messages: [
      { role: "system", content: "Follow the runtime policy." },
      { role: "user", content: "Inspect the selected record." }
    ],
    tools: Array.from({ length: toolCount }, (_, index) => ({
      type: "function",
      function: {
        name: `fixture.lookup_${index}`,
        description: `Fixture schema ${index} ${protectedFixtureValue}`,
        parameters: {
          type: "object",
          properties: {
            recordId: { type: "string" }
          },
          required: ["recordId"]
        }
      }
    }))
  };
}

describe("estimateProviderRequestAccounting", () => {
  it("reports deterministic schema, message, output, and total estimates", () => {
    const request = fixtureRequest();
    const serializedSchemas = JSON.stringify(request.tools);
    const accounting = estimateProviderRequestAccounting(request, 4096);

    expect(accounting).toEqual({
      selectedToolCount: 1,
      serializedSchemaBytes: Buffer.byteLength(serializedSchemas, "utf8"),
      estimatedSchemaTokens: Math.ceil(serializedSchemas.length / CHARS_PER_TOKEN),
      estimatedMessageTokens: estimateMessagesTokensRough([
        { role: "system", content: "Follow the runtime policy." },
        { role: "user", content: "Inspect the selected record." }
      ]),
      estimatedInputTokens: accounting.estimatedMessageTokens + accounting.estimatedSchemaTokens,
      outputReservationTokens: 4096,
      totalEstimatedRequestTokens: accounting.estimatedInputTokens + 4096
    });
  });

  it("changes with the exact selected schemas and counts no absent schema payload", () => {
    const noTools = estimateProviderRequestAccounting({
      ...fixtureRequest(0),
      tools: undefined
    }, 1000);
    const oneTool = estimateProviderRequestAccounting(fixtureRequest(1), 1000);
    const twoTools = estimateProviderRequestAccounting(fixtureRequest(2), 1000);

    expect(noTools).toMatchObject({
      selectedToolCount: 0,
      serializedSchemaBytes: 0,
      estimatedSchemaTokens: 0
    });
    expect(oneTool.selectedToolCount).toBe(1);
    expect(twoTools.selectedToolCount).toBe(2);
    expect(twoTools.serializedSchemaBytes).toBeGreaterThan(oneTool.serializedSchemaBytes);
    expect(twoTools.estimatedSchemaTokens).toBeGreaterThan(oneTool.estimatedSchemaTokens);
    expect(twoTools.totalEstimatedRequestTokens).toBeGreaterThan(oneTool.totalEstimatedRequestTokens);
  });

  it("emits numeric diagnostics without protected schema content", () => {
    const accounting = estimateProviderRequestAccounting(fixtureRequest(), 4096);

    expect(JSON.stringify(accounting)).not.toContain(protectedFixtureValue);
    expect(Object.values(accounting).every((value) => typeof value === "number")).toBe(true);
  });
});
