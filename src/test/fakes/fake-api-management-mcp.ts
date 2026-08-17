export const FAKE_API_MANAGEMENT_MCP_URL = "https://control-plane.example.test/mcp";

export type FakeManagedState = {
  targetId: string;
  settings: {
    region: string;
    retryLimit: number;
    labels: string[];
  };
  values: Array<{ name: string; value: string }>;
};

export type FakeApiManagementMcpOptions = {
  exposeMutation?: boolean;
  failVerification?: boolean;
  echoProtectedValues?: boolean;
};

/** In-memory JSON-RPC peer used only by the governed provisioning acceptance journey. */
export class FakeApiManagementMcp {
  readonly timeline: string[] = [];
  readonly readInputs: Record<string, unknown>[] = [];
  readonly mutationInputs: Record<string, unknown>[] = [];
  readonly verificationInputs: Record<string, unknown>[] = [];
  readonly initialSettings: FakeManagedState["settings"] = {
    region: "test-region-1",
    retryLimit: 4,
    labels: ["existing", "preserve"],
  };
  readonly #options: Required<FakeApiManagementMcpOptions>;
  #state: FakeManagedState;

  constructor(options: FakeApiManagementMcpOptions = {}) {
    this.#options = {
      exposeMutation: options.exposeMutation ?? true,
      failVerification: options.failVerification ?? false,
      echoProtectedValues: options.echoProtectedValues ?? true,
    };
    this.#state = {
      targetId: "fictional-target",
      settings: structuredClone(this.initialSettings),
      values: [],
    };
  }

  readonly fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = JSON.parse(String(init?.body ?? "{}")) as {
      id?: number;
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    if (request.id === undefined) return jsonResponse({});

    let result: unknown;
    if (request.method === "initialize") {
      result = { capabilities: { tools: {} } };
    } else if (request.method === "tools/list") {
      result = { tools: this.#tools() };
    } else if (request.method === "tools/call") {
      try {
        result = this.#call(request.params?.name, request.params?.arguments ?? {});
      } catch (error) {
        return jsonResponse({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32_001, message: error instanceof Error ? error.message : "Fake MCP failure" },
        });
      }
    } else {
      result = {};
    }
    return jsonResponse({ jsonrpc: "2.0", id: request.id, result });
  };

  state(): FakeManagedState {
    return structuredClone(this.#state);
  }

  #tools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    const tools = [
      readTool("readState", "Read existing managed state before a change."),
      readTool("verifyState", "Independently read managed state after a change."),
    ];
    if (this.#options.exposeMutation) tools.splice(1, 0, updateTool());
    return tools;
  }

  #call(name: string | undefined, input: Record<string, unknown>): unknown {
    if (name === "readState") {
      this.timeline.push("destination-read");
      this.readInputs.push(structuredClone(input));
      return textResult(this.#safeState());
    }
    if (name === "updateState" && this.#options.exposeMutation) {
      this.timeline.push("destination-mutation");
      this.mutationInputs.push(structuredClone(input));
      this.#applyUpdate(input);
      const values = this.#state.values.map((entry) => entry.value);
      return textResult({
        accepted: true,
        ...(this.#options.echoProtectedValues ? {
          echoed: values,
          transformed: values.map((value) => Buffer.from(value, "utf8").toString("base64")),
        } : {}),
      });
    }
    if (name === "verifyState") {
      this.timeline.push("destination-verification");
      this.verificationInputs.push(structuredClone(input));
      if (this.#options.failVerification) throw new Error("Independent verification is unavailable.");
      return textResult(this.#safeState());
    }
    throw new Error(`Unknown fake MCP tool: ${name ?? "missing"}`);
  }

  #applyUpdate(input: Record<string, unknown>): void {
    const targetId = input.targetId;
    const settings = input.settings;
    const values = input.values;
    if (typeof targetId !== "string" || !isSettings(settings) || !Array.isArray(values)) {
      throw new Error("Mutation input is malformed.");
    }
    const parsedValues = values.map((entry) => {
      if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.value !== "string") {
        throw new Error("Mutation values are malformed.");
      }
      return { name: entry.name, value: entry.value };
    });
    this.#state = {
      targetId,
      settings: structuredClone(settings),
      values: parsedValues,
    };
  }

  #safeState(): Omit<FakeManagedState, "values"> & { values: Array<{ name: string; configured: boolean }> } {
    return {
      targetId: this.#state.targetId,
      settings: structuredClone(this.#state.settings),
      values: this.#state.values.map((entry) => ({ name: entry.name, configured: entry.value.length > 0 })),
    };
  }
}

function readTool(name: string, description: string) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { targetId: { type: "string" } },
      required: ["targetId"],
    },
  };
}

function updateTool() {
  return {
    name: "updateState",
    description: "Replace managed state in one operation.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        targetId: { type: "string" },
        settings: {
          type: "object",
          additionalProperties: false,
          properties: {
            region: { type: "string" },
            retryLimit: { type: "integer" },
            labels: { type: "array", items: { type: "string" } },
          },
          required: ["region", "retryLimit", "labels"],
        },
        values: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              value: { type: "string" },
            },
            required: ["name", "value"],
          },
        },
      },
      required: ["targetId", "settings", "values"],
    },
  };
}

function textResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function isSettings(value: unknown): value is FakeManagedState["settings"] {
  return isRecord(value) && typeof value.region === "string" && Number.isInteger(value.retryLimit) &&
    Array.isArray(value.labels) && value.labels.every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
