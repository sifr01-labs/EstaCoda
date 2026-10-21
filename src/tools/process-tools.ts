import type { RegisteredTool, SessionToolProvider, ToolResult } from "../contracts/tool.js";
import type { EnvironmentType } from "../contracts/security.js";
import { assessHardlineFloor } from "../security/command-safety.js";
import type { ProcessManager } from "../process/process-manager.js";
import type { SecureInputKind, SecureInputRetention } from "../contracts/secure-input.js";

export type ProcessToolOptions = {
  processManager: ProcessManager;
};

type ProtectedInputDescriptor = {
  kind?: SecureInputKind;
  purpose?: string;
  retention?: SecureInputRetention;
};

type ProtectedInputEnvelope = {
  ref?: string;
  protectedInput?: ProtectedInputDescriptor;
};

export function createProcessTools(options: ProcessToolOptions): readonly RegisteredTool[] {
  return [
    {
      name: "process.start",
      description: "Start a long-running workspace process in the background. Omit protectedEnvironment or use null for ordinary commands; supply it only when requesting protected credential delivery. Use process.logs and process.list to observe completion, and process.stop to cancel.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          protectedEnvironment: { anyOf: [protectedInputEnvelopeSchema(), { type: "null" }] }
        },
        required: ["command"]
      },
      riskClass: "workspace-write",
      toolsets: ["shell-write", "coding", "research"],
      progressLabel: "starting process",
      maxResultSizeChars: 3000,
      isAvailable: () => true,
      run: async (input: { command?: string; protectedEnvironment?: ProtectedInputEnvelope | null }, context) => {
        if (context?.signal?.aborted) return errorResult("Process start cancelled before dispatch.");
        if (typeof input.command !== "string" || input.command.trim().length === 0) {
          return errorResult("command must be a non-empty string");
        }

        const blockedReason = explainCommandBlock(input.command, context?.environmentType);
        if (blockedReason !== undefined) {
          return errorResult(blockedReason);
        }

        if (!isAbsentProtectedEnvironment(input.protectedEnvironment)) {
          if (input.protectedEnvironment === null || typeof input.protectedEnvironment !== "object" || Array.isArray(input.protectedEnvironment)) {
            return errorResult("protectedEnvironment must be a protected input object or null");
          }
          const descriptor = parseProtectedInputEnvelope(input.protectedEnvironment, "use-once");
          const variableName = input.protectedEnvironment.ref;
          if (descriptor === undefined || typeof variableName !== "string" || !isEnvironmentVariableName(variableName)) {
            return errorResult("protectedEnvironment requires an environment-variable ref and valid use-once protectedInput metadata");
          }
          if (context?.onSecureInputRequest === undefined) {
            return errorResult("Protected process environment input is unavailable on this runtime.");
          }
          const process = await options.processManager.prepareProtectedEnvironment(input.command, variableName);
          const receipt = await context.onSecureInputRequest({
            kind: descriptor.kind,
            purpose: descriptor.purpose,
            retention: "use-once",
            destination: {
              type: "process-environment",
              processId: process.id,
              variableName
            }
          }, async () => undefined).catch(() => undefined);
          if (receipt?.status !== "delivered") {
            options.processManager.releasePrepared(process.id);
            return errorResult(receipt === undefined
              ? "Protected process environment delivery failed."
              : `Protected process environment ${receipt.status}: ${receipt.reason ?? "delivery did not complete."}`);
          }
          const started = options.processManager.get(process.id);
          return {
            ok: started?.status === "running",
            content: `Started ${process.id} with protected environment input.`,
            metadata: { process: started, secureInputReceipt: receipt }
          };
        }

        const process = await options.processManager.start(input.command, context?.signal, { continuationSignal: context?.continuationSignal, requirements: context?.requestContract?.requirements, visibleTurnId: context?.visibleTurnId });

        return {
          ok: process.status === "running",
          content: `Started ${process.id}: ${process.command}`,
          metadata: {
            process,
            commandFileObservation: await options.processManager.fileObservation(process.id)
          }
        };
      }
    },
    {
      name: "process.input",
      description: "Supply protected input to a verified prompt already emitted by a managed process.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          promptLabel: { type: "string" },
          protectedInput: protectedInputDescriptorSchema()
        },
        required: ["id", "promptLabel", "protectedInput"]
      },
      riskClass: "credential-access",
      toolsets: ["shell-write", "coding", "research"],
      progressLabel: "supplying protected process input",
      maxResultSizeChars: 3000,
      isAvailable: () => true,
      run: async (input: { id?: string; promptLabel?: string; protectedInput?: ProtectedInputDescriptor }, context) => {
        const descriptor = parseProtectedInputDescriptor(input.protectedInput, "use-once");
        if (
          typeof input.id !== "string" || input.id.length === 0 ||
          typeof input.promptLabel !== "string" || input.promptLabel.trim().length === 0 ||
          descriptor === undefined
        ) {
          return errorResult("process.input requires id, promptLabel, and valid use-once protectedInput metadata");
        }
        if (context?.onSecureInputRequest === undefined) {
          return errorResult("Protected process input is unavailable on this runtime.");
        }
        const receipt = await context.onSecureInputRequest({
          kind: descriptor.kind,
          purpose: descriptor.purpose,
          retention: "use-once",
          destination: {
            type: "process-stdin",
            processId: input.id,
            promptLabel: input.promptLabel.trim()
          }
        }, async () => undefined).catch(() => undefined);
        if (receipt === undefined) return errorResult("Protected process input delivery failed.");
        return {
          ok: receipt.status === "delivered",
          content: receipt.status === "delivered"
            ? `Protected input delivered to ${receipt.destinationLabel}.`
            : `Protected process input ${receipt.status}: ${receipt.reason ?? "delivery did not complete."}`,
          metadata: { secureInputReceipt: receipt }
        };
      }
    },
    {
      name: "process.list",
      description: "List background processes for the active runtime.",
      inputSchema: {
        type: "object",
        properties: {}
      },
      riskClass: "read-only-local",
      toolsets: ["shell-readonly", "coding", "research"],
      progressLabel: "listing processes",
      maxResultSizeChars: 6000,
      isAvailable: () => true,
      run: async () => {
        const processes = options.processManager.list();

        return {
          ok: true,
          content: processes.length === 0
            ? "No managed processes."
            : processes
                .map((process) => `${process.id}\t${process.status}\t${process.command}`)
                .join("\n"),
          metadata: {
            processes
          }
        };
      }
    },
    {
      name: "process.logs",
      description: "Wait for a managed process to finish and read its logs. Defaults to a bounded 30-second wait while running; repeat for long jobs instead of shell polling. Set waitMs to 0 for an immediate snapshot. Waiting never proves task completion.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          tailChars: { type: "number" },
          waitMs: { type: "number", minimum: 0, maximum: 30_000 }
        },
        required: ["id"]
      },
      riskClass: "read-only-local",
      toolsets: ["shell-readonly", "coding", "research"],
      progressLabel: "reading process logs",
      maxResultSizeChars: 12_000,
      isAvailable: () => true,
      run: async (input: { id?: string; tailChars?: number; waitMs?: number | null }, context) => {
        if (typeof input.id !== "string" || input.id.length === 0) {
          return errorResult("id must be a non-empty string");
        }
        const waitMs = input.waitMs ?? 30_000;
        if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 30_000) {
          return errorResult("waitMs must be between 0 and 30000 ms");
        }
        const started = performance.now();
        const process = await options.processManager.wait(input.id, waitMs, context?.signal);
        const waitedMs = Math.floor(performance.now() - started);

        const logs = options.processManager.logs(input.id, {
          tailChars: input.tailChars
        });

        if (logs === undefined) {
          return errorResult(`No managed process found for ${input.id}.`);
        }
        return {
          ok: true,
          content: [`Process ${input.id}: ${process?.status ?? "unknown"}${process?.exitCode == null ? "" : `, exit code ${process.exitCode}`}${process?.signal ? `, signal ${process.signal}` : ""}.`, logs.length === 0
            ? "(no logs)"
            : logs.map((log) => `[${log.stream}] ${log.text.trimEnd()}`).join("\n")].join("\n"),
          metadata: {
            id: input.id,
            waitedMs,
            logs,
            commandFileObservation: await options.processManager.fileObservation(input.id),
            process
          }
        };
      }
    },
    {
      name: "process.stop",
      description: "Stop a managed background process.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          signal: { type: "string" }
        },
        required: ["id"]
      },
      riskClass: "workspace-write",
      toolsets: ["shell-write", "coding", "research"],
      progressLabel: "stopping process",
      maxResultSizeChars: 3000,
      isAvailable: () => true,
      run: async (input: { id?: string; signal?: NodeJS.Signals }) => {
        if (typeof input.id !== "string" || input.id.length === 0) {
          return errorResult("id must be a non-empty string");
        }

        const process = await options.processManager.stop(input.id, input.signal ?? "SIGTERM");

        if (process === undefined) {
          return errorResult(`No managed process found for ${input.id}.`);
        }

        return {
          ok: true,
          content: `${process.status === "stopped" ? "Stopped" : "Process already finished"} ${process.id}: ${process.command}`,
          metadata: {
            process
          }
        };
      }
    }
  ];
}

function protectedInputDescriptorSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      kind: { type: "string" },
      purpose: { type: "string" },
      retention: { type: "string" }
    },
    required: ["kind", "purpose"]
  };
}

// Some providers fill optional objects with empty fields. Only an entirely
// empty known envelope means absence; partial requests and unknown fields fail closed.
function isAbsentProtectedEnvironment(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, entry]) => {
    if (key === "ref") return entry === "";
    if (key !== "protectedInput" || entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
    return Object.entries(entry).every(([name, field]) => ["kind", "purpose", "retention"].includes(name) && field === "");
  });
}

function protectedInputEnvelopeSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      ref: { type: "string" },
      protectedInput: protectedInputDescriptorSchema()
    },
    required: ["ref", "protectedInput"]
  };
}

function parseProtectedInputEnvelope(
  value: ProtectedInputEnvelope,
  retention: SecureInputRetention
): { kind: SecureInputKind; purpose: string } | undefined {
  return parseProtectedInputDescriptor(value.protectedInput, retention);
}

function parseProtectedInputDescriptor(
  value: ProtectedInputDescriptor | undefined,
  retention: SecureInputRetention
): { kind: SecureInputKind; purpose: string } | undefined {
  if (value === undefined || value === null || typeof value !== "object" || !SECURE_INPUT_KINDS.has(value.kind as SecureInputKind)) return undefined;
  if (typeof value.purpose !== "string" || value.purpose.trim().length === 0 || value.purpose.length > 500) return undefined;
  if (value.retention !== undefined && value.retention !== retention) return undefined;
  return { kind: value.kind as SecureInputKind, purpose: value.purpose.trim() };
}

const SECURE_INPUT_KINDS = new Set<SecureInputKind>([
  "account-identifier", "password", "one-time-code", "api-key", "client-secret", "access-token",
  "private-key", "recovery-code", "generic-secret"
]);

function isEnvironmentVariableName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value);
}

export const processToolProvider: SessionToolProvider = {
  name: "process",
  kind: "session",
  createTools(ctx) {
    return createProcessTools({
      processManager: requireProviderDependency("process", "processManager", ctx.processManager)
    });
  }
};

function requireProviderDependency<T>(provider: string, dependency: string, value: T | undefined): T {
  if (value === undefined) {
    throw new TypeError(`${provider}ToolProvider requires ${dependency}.`);
  }
  return value;
}

function explainCommandBlock(command: string, environmentType?: EnvironmentType): string | undefined {
  return assessHardlineFloor(command, { environmentType })?.reason;
}

function errorResult(content: string): ToolResult {
  return {
    ok: false,
    content
  };
}
