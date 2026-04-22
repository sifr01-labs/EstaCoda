export type RuntimeEvent =
  | {
      kind: "agent-start";
      sessionId: string;
      input: string;
    }
  | {
      kind: "intent";
      labels: string[];
      confidence: number;
    }
  | {
      kind: "skill";
      name: string;
    }
  | {
      kind: "tool-start";
      tool: string;
      stepId?: string;
    }
  | {
      kind: "tool-result";
      tool: string;
      decision?: string;
      riskClass?: string;
      ok?: boolean;
      chars?: number;
      sentChars?: number;
      truncated?: boolean;
    }
  | {
      kind: "provider-attempt";
      provider: string;
      model: string;
      fallback: boolean;
    }
  | {
      kind: "provider-token";
      provider: string;
      model: string;
      text: string;
    }
  | {
      kind: "provider-tool-call";
      provider: string;
      model: string;
      index?: number;
      id?: string;
      name?: string;
      argumentsText?: string;
    }
  | {
      kind: "provider-result";
      provider: string;
      model: string;
      ok: boolean;
      fallback: boolean;
      willFallback: boolean;
      errorClass?: string;
    }
  | {
      kind: "provider-budget-exhausted";
      budget: string;
      limit: number;
      observed: number;
      reason: string;
    }
  | {
      kind: "agent-cancelled";
      reason: string;
      resumeNote?: string;
    }
  | {
      kind: "agent-final";
      text: string;
    };

export type RuntimeEventSink = (event: RuntimeEvent) => void | Promise<void>;
