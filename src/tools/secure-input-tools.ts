import type { RegisteredTool, ToolResult } from "../contracts/tool.js";
import type { SecureInputKind } from "../contracts/secure-input.js";

type StoreProtectedInput = {
  kind?: SecureInputKind;
  purpose?: string;
  retention?: string;
};

export function createRegisteredSecretStoreTool(): RegisteredTool {
  return {
    name: "secure_input.store",
    description: "Request protected input and save it to a reviewed profile-local secret store after explicit authorization.",
    inputSchema: {
      type: "object",
      properties: {
        storeId: { type: "string", enum: ["profile-env"] },
        entryName: { type: "string" },
        protectedInput: {
          type: "object",
          properties: {
            kind: { type: "string" },
            purpose: { type: "string" },
            retention: { type: "string" }
          },
          required: ["kind", "purpose"]
        }
      },
      required: ["storeId", "entryName", "protectedInput"]
    },
    riskClass: "shared-state-mutation",
    toolsets: ["core"],
    progressLabel: "saving protected input",
    maxResultSizeChars: 3000,
    isAvailable: () => true,
    run: async (input: {
      storeId?: string;
      entryName?: string;
      protectedInput?: StoreProtectedInput;
    }, context) => {
      const descriptor = parseDescriptor(input.protectedInput);
      if (
        typeof input.storeId !== "string" || input.storeId.trim().length === 0 ||
        typeof input.entryName !== "string" || input.entryName.trim().length === 0 ||
        descriptor === undefined
      ) {
        return failure("secure_input.store requires a registered store, entry name, and profile-secret-store metadata");
      }
      if (context?.onSecureInputRequest === undefined) {
        return failure("Protected secret storage is unavailable on this runtime.");
      }
      const receipt = await context.onSecureInputRequest({
        kind: descriptor.kind,
        purpose: descriptor.purpose,
        retention: "profile-secret-store",
        destination: {
          type: "registered-store",
          storeId: input.storeId.trim(),
          entryName: input.entryName.trim()
        }
      }, async () => undefined).catch(() => undefined);
      if (receipt === undefined) return failure("Protected secret storage failed.");
      return {
        ok: receipt.status === "delivered" && receipt.persisted,
        content: receipt.status === "delivered"
          ? `Protected input saved to ${receipt.destinationLabel}.`
          : `Protected secret storage ${receipt.status}: ${receipt.reason ?? "storage did not complete."}`,
        metadata: { secureInputReceipt: receipt }
      };
    }
  };
}

function parseDescriptor(value: StoreProtectedInput | undefined): {
  kind: SecureInputKind;
  purpose: string;
} | undefined {
  if (value === undefined || !KINDS.has(value.kind as SecureInputKind)) return undefined;
  if (typeof value.purpose !== "string" || value.purpose.trim().length === 0 || value.purpose.length > 500) return undefined;
  if (value.retention !== undefined && value.retention !== "profile-secret-store") return undefined;
  return { kind: value.kind as SecureInputKind, purpose: value.purpose.trim() };
}

const KINDS = new Set<SecureInputKind>([
  "password", "one-time-code", "api-key", "client-secret", "access-token",
  "private-key", "recovery-code", "generic-secret"
]);

function failure(content: string): ToolResult {
  return { ok: false, content, metadata: { reason: "protected-store-unavailable" } };
}
