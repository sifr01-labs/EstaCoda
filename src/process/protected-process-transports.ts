import type { SecureInputTransport } from "../security/secure-input-transport-registry.js";
import type { ProcessManager } from "./process-manager.js";

export function createProtectedProcessStdinTransport(
  processManager: ProcessManager
): SecureInputTransport {
  return {
    id: "managed-process-stdin",
    destinationTypes: ["process-stdin"],
    priority: 400,
    verificationStrength: "runtime-bound",
    persistence: "none",
    disclosureBoundary: "destination",
    requiresApproval: false,
    isAvailable: (request) => request.destination.type === "process-stdin" &&
      typeof request.destination.promptLabel === "string" &&
      processManager.hasObservedPrompt(request.destination.processId, request.destination.promptLabel),
    verify: ({ request }) => {
      if (
        request.destination.type !== "process-stdin" ||
        typeof request.destination.promptLabel !== "string" ||
        !processManager.hasObservedPrompt(request.destination.processId, request.destination.promptLabel)
      ) {
        return { status: "rejected", code: "destination-not-verifiable" };
      }
      return { status: "verified", destination: structuredClone(request.destination) };
    },
    deliver: async ({ value, context, consume }) => {
      const destination = context.request.destination;
      if (
        destination.type !== "process-stdin" ||
        typeof destination.promptLabel !== "string" ||
        !processManager.writeProtectedInput(destination.processId, destination.promptLabel, value)
      ) {
        throw new Error("Protected process prompt changed before delivery.");
      }
      await consume(value, context);
    }
  };
}

export function createProtectedProcessEnvironmentTransport(
  processManager: ProcessManager
): SecureInputTransport {
  return {
    id: "managed-process-environment",
    destinationTypes: ["process-environment"],
    priority: 300,
    verificationStrength: "runtime-bound",
    persistence: "none",
    disclosureBoundary: "destination",
    requiresApproval: false,
    isAvailable: (request) => request.destination.type === "process-environment" &&
      processManager.canStartProtectedEnvironment(
        request.destination.processId,
        request.destination.variableName
      ),
    verify: ({ request }) => {
      if (
        request.destination.type !== "process-environment" ||
        !processManager.canStartProtectedEnvironment(
          request.destination.processId,
          request.destination.variableName
        )
      ) {
        return { status: "rejected", code: "destination-not-verifiable" };
      }
      return { status: "verified", destination: structuredClone(request.destination) };
    },
    deliver: async ({ value, context, consume }) => {
      const destination = context.request.destination;
      if (
        destination.type !== "process-environment" ||
        processManager.startProtectedEnvironment(
          destination.processId,
          destination.variableName,
          value
        ) === undefined
      ) {
        throw new Error("Protected process environment changed before delivery.");
      }
      await consume(value, context);
    },
    release: (request) => {
      if (request.destination.type === "process-environment") {
        processManager.releasePrepared(request.destination.processId);
      }
    }
  };
}
