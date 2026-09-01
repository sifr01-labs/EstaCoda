import { describe, expect, it } from "vitest";
import type { ProviderExecutionResult } from "../providers/provider-executor.js";
import {
  namespaceProviderToolCalls,
  runtimeProviderToolCallId
} from "./provider-tool-call-identity.js";

const namespace = "00000000-0000-4000-8000-000000000001";

describe("runtime provider tool-call identity", () => {
  it("is stable for one runtime position and distinct across iterations and ordinals", () => {
    const first = runtimeProviderToolCallId({ namespace, providerIteration: 0, callOrdinal: 0 });

    expect(first).toBe(runtimeProviderToolCallId({ namespace, providerIteration: 0, callOrdinal: 0 }));
    expect(first).toMatch(/^tool-call-[a-f0-9]{24}$/u);
    expect(runtimeProviderToolCallId({ namespace, providerIteration: 0, callOrdinal: 1 })).not.toBe(first);
    expect(runtimeProviderToolCallId({ namespace, providerIteration: 1, callOrdinal: 0 })).not.toBe(first);
    expect(runtimeProviderToolCallId({
      namespace: "00000000-0000-4000-8000-000000000099",
      providerIteration: 0,
      callOrdinal: 0
    })).not.toBe(first);
  });

  it("replaces repeated and missing provider IDs without using tool arguments", () => {
    const execution = providerExecution([
      { id: "browser_download_1", name: "browser.download", argumentsText: "{\"token\":\"secret-one\"}" },
      { id: "browser_download_1", name: "browser.download", argumentsText: "{\"token\":\"secret-two\"}" },
      { name: "browser.download", argumentsText: "{\"token\":\"secret-three\"}" }
    ]);
    const normalized = namespaceProviderToolCalls({ execution, namespace, providerIteration: 4 });
    const ids = normalized.toolCalls.map((toolCall) => toolCall.id);

    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id) => /^tool-call-[a-f0-9]{24}$/u.test(id ?? ""))).toBe(true);
    expect(JSON.stringify(ids)).not.toContain("browser_download_1");
    expect(JSON.stringify(ids)).not.toContain("secret");
    const changedProviderPayload = namespaceProviderToolCalls({
      execution: providerExecution([{
        id: "provider-changed-the-id",
        name: "provider.changed_the_tool_name",
        argumentsText: "{\"token\":\"entirely-different-secret\"}"
      }]),
      namespace,
      providerIteration: 4
    });
    expect(changedProviderPayload.toolCalls[0]?.id).toBe(ids[0]);
    expect(execution.toolCalls.map((toolCall) => toolCall.id)).toEqual([
      "browser_download_1",
      "browser_download_1",
      undefined
    ]);
  });

  it("returns an execution without tool calls unchanged", () => {
    const execution = providerExecution([]);

    expect(namespaceProviderToolCalls({ execution, namespace, providerIteration: 0 })).toBe(execution);
  });
});

function providerExecution(toolCalls: ProviderExecutionResult["toolCalls"]): ProviderExecutionResult {
  return {
    ok: true,
    response: {
      ok: true,
      content: "",
      provider: "test-provider",
      model: "test-model"
    },
    fallbackUsed: false,
    attempts: [],
    toolCalls
  };
}
