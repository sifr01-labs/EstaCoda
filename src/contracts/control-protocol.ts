/** Existing shared-host v1 semantics. Pure contract only: no transport or authority. */
export const PRIVATE_CONTROL_MAX_BYTES = 131_072;
export type PrivateControlRequest = {
  method: "send" | "cancel" | "approval" | "inspect" | "start" | "resume";
  sessionId: string; targetId: string; operationId: string;
  targetGeneration?: number;
  text?: string; approvalId?: string; decision?: "approved" | "denied";
};

export function validatePrivateControlRequest(value: unknown): asserts value is PrivateControlRequest {
  if (!value || typeof value !== "object") throw new Error("Invalid control request.");
  const request = value as PrivateControlRequest;
  if (!["send", "cancel", "approval", "inspect", "start", "resume"].includes(request.method) ||
    [request.sessionId, request.targetId, request.operationId].some((id) => typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(id)) ||
    (request.targetGeneration !== undefined && (!Number.isSafeInteger(request.targetGeneration) || request.targetGeneration < 1)) ||
    (request.method === "send" && (typeof request.text !== "string" || request.text.length < 1 || request.text.length > 32_768)) ||
    (request.method === "approval" && (typeof request.approvalId !== "string" || request.approvalId.length > 160 || !["approved", "denied"].includes(request.decision ?? "")))) {
    throw new Error("Invalid control request.");
  }
}
