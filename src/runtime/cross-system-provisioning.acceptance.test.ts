import { inspect } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupervisedLocalCdpBrowserBackend } from "../browser/supervised-local-cdp-backend.js";
import type { ExecutionFinalOutcomeStatus } from "../contracts/execution-plan.js";
import type {
  ModelProfile,
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  ResolvedModelRoute,
} from "../contracts/provider.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import { latestExecutionPlanSnapshot } from "../session/execution-plan-state.js";
import {
  FakeApiManagementMcp,
  FAKE_API_MANAGEMENT_MCP_URL,
} from "../test/fakes/fake-api-management-mcp.js";
import {
  FakeCdpAuthPortalSocket,
  createFakeCdpFetch,
} from "../test/fakes/fake-cdp-auth-portal.js";
import {
  FAKE_DEVELOPER_PORTAL_ORIGIN,
  FAKE_DEVELOPER_PORTAL_URL,
  replaceProtectedProvisioningValue,
  showProtectedProvisioningValues,
} from "../test/fakes/fake-developer-portal.js";
import { resolveTokens } from "../theme/token-resolver.js";
import { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import { createRuntime, type Runtime } from "./create-runtime.js";
import type { SecureInputAuthorizationHandler } from "./secure-input-coordinator.js";

const FIRST_PROTECTED_VALUE = "fictional-browser-value-alpha";
const SECOND_PROTECTED_VALUE = "fictional-browser-value-beta";
const CHANGED_PROTECTED_VALUE = "fictional-browser-value-changed";
const PROTECTED_DERIVATIVES = [
  Buffer.from(FIRST_PROTECTED_VALUE, "utf8").toString("base64"),
  Buffer.from(SECOND_PROTECTED_VALUE, "utf8").toString("base64"),
] as const;
const FORBIDDEN_VALUES = [
  FIRST_PROTECTED_VALUE,
  SECOND_PROTECTED_VALUE,
  CHANGED_PROTECTED_VALUE,
  ...PROTECTED_DERIVATIVES,
] as const;
const SERVER_ID = "fictional_control_plane";
const READ_TOOL = `mcp.${SERVER_ID}.readState`;
const MUTATION_TOOL = `mcp.${SERVER_ID}.updateState`;
const VERIFY_TOOL = `mcp.${SERVER_ID}.verifyState`;
const TARGET_ID = "fictional-target";

const model: ModelProfile = {
  id: "cross-system-acceptance-model",
  provider: "cross-system-acceptance",
  contextWindowTokens: 128_000,
  supportsTools: true,
  supportsVision: false,
  supportsStructuredOutput: true,
};

const route: ResolvedModelRoute = {
  provider: model.provider,
  id: model.id,
  profile: model,
  authMethod: "none",
};

type JourneyScenario = {
  name: string;
  approval?: "approved" | "denied";
  changeSourceAfterApproval?: boolean;
  undeclaredDestination?: boolean;
  exposeMutation?: boolean;
  failVerification?: boolean;
  expectCompleted: boolean;
  expectedFinalOutcome: ExecutionFinalOutcomeStatus;
  expectedMutationCalls: number;
  expectedVerificationCalls: number;
  expectedTimeline: string[];
  expectedProviderRequests: number;
  expectedToolExecutions: number;
  expectedPlanExecutions: number;
};

const scenarios: JourneyScenario[] = [
  {
    name: "provisions two protected values and verifies the independently read state",
    expectCompleted: true,
    expectedFinalOutcome: "completed",
    expectedMutationCalls: 1,
    expectedVerificationCalls: 1,
    expectedTimeline: ["destination-read", "destination-mutation", "destination-verification"],
    expectedProviderRequests: 10,
    expectedToolExecutions: 9,
    expectedPlanExecutions: 5,
  },
  {
    name: "denied grouped approval performs no destination mutation",
    approval: "denied",
    expectCompleted: false,
    expectedFinalOutcome: "partially_completed",
    expectedMutationCalls: 0,
    expectedVerificationCalls: 0,
    expectedTimeline: ["destination-read"],
    expectedProviderRequests: 12,
    expectedToolExecutions: 8,
    expectedPlanExecutions: 5,
  },
  {
    name: "a browser source changed after approval performs no destination mutation",
    changeSourceAfterApproval: true,
    expectCompleted: false,
    expectedFinalOutcome: "partially_completed",
    expectedMutationCalls: 0,
    expectedVerificationCalls: 0,
    expectedTimeline: ["destination-read"],
    expectedProviderRequests: 12,
    expectedToolExecutions: 8,
    expectedPlanExecutions: 5,
  },
  {
    name: "an undeclared destination path performs no destination mutation",
    undeclaredDestination: true,
    expectCompleted: false,
    expectedFinalOutcome: "partially_completed",
    expectedMutationCalls: 0,
    expectedVerificationCalls: 0,
    expectedTimeline: ["destination-read"],
    expectedProviderRequests: 12,
    expectedToolExecutions: 8,
    expectedPlanExecutions: 5,
  },
  {
    name: "a missing mutation capability blocks before the browser opens",
    exposeMutation: false,
    expectCompleted: false,
    expectedFinalOutcome: "blocked",
    expectedMutationCalls: 0,
    expectedVerificationCalls: 0,
    expectedTimeline: [],
    expectedProviderRequests: 1,
    expectedToolExecutions: 1,
    expectedPlanExecutions: 1,
  },
  {
    name: "a successful mutation with failed verification leaves the Mission incomplete",
    failVerification: true,
    expectCompleted: false,
    expectedFinalOutcome: "partially_completed",
    expectedMutationCalls: 1,
    expectedVerificationCalls: 1,
    expectedTimeline: ["destination-read", "destination-mutation", "destination-verification"],
    expectedProviderRequests: 10,
    expectedToolExecutions: 9,
    expectedPlanExecutions: 5,
  },
];

const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  while (tempRoots.length > 0) await rm(tempRoots.pop()!, { recursive: true, force: true });
});

describe.sequential("governed cross-system provisioning acceptance", () => {
  it.each(scenarios)("$name", async (scenario) => {
    const harness = await createJourneyHarness(scenario);
    let response: Awaited<ReturnType<Runtime["handle"]>> | undefined;
    let thrown: unknown;
    let disposed = false;

    try {
      response = await harness.runtime.handle({
        text: "Configure the fictional control plane from the approved source records, then read back and verify the resulting state.",
        channel: "cli",
        trustedWorkspace: true,
        onSecureInputRequest: harness.secureInputHandler,
        onEvent: async (event) => { harness.runtimeEvents.push(structuredClone(event)); },
      });
    } catch (error) {
      thrown = error;
    }

    try {
      expect(thrown).toBeUndefined();
      expect(response).toBeDefined();
      const toolNames = response!.toolExecutions.map((execution) => execution.tool.name);
      expect(toolNames[0]).toBe("plan");
      const firstRequestTools = firstRequestToolNames(harness.providerRequests[0]);
      expect(firstRequestTools).toEqual(expect.arrayContaining([
        "plan",
        providerToolName(READ_TOOL),
        providerToolName(VERIFY_TOOL),
      ]));
      expect(firstRequestTools).not.toContain(providerToolName("browser.navigate"));
      if (scenario.exposeMutation === false) expect(firstRequestTools).not.toContain(providerToolName(MUTATION_TOOL));
      else expect(firstRequestTools).toContain(providerToolName(MUTATION_TOOL));

      const messages = await harness.runtime.sessionDb.listMessages(harness.runtime.sessionId);
      const events = await harness.runtime.sessionDb.listEvents(harness.runtime.sessionId);
      const mission = latestExecutionPlanSnapshot(events);
      expect(mission).toBeDefined();
      expect(mission?.requirements).toHaveLength(4);

      if (scenario.exposeMutation === false) {
        expect(mission).toMatchObject({
          status: "blocked",
          capabilityPreflight: {
            status: "blocked",
            assessments: expect.arrayContaining([
              expect.objectContaining({ tool: MUTATION_TOOL, status: "missing", reasonCode: "tool_missing" }),
            ]),
          },
        });
        expect(toolNames).toEqual(["plan"]);
        expect(toolNames).not.toContain("browser.navigate");
        expect(harness.socket.sent.some((command) => command.method === "Page.navigate")).toBe(false);
        expect(response!.text).toContain("required capability is unavailable");
      } else {
        const preflightReady = events.find((event) =>
          (event.kind === "execution-plan-started" || event.kind === "execution-plan-updated") &&
          event.plan.capabilityPreflight?.status === "ready"
        );
        expect(preflightReady).toBeDefined();
        expect(firstRequestToolNames(harness.providerRequests[1])).toContain(providerToolName("browser.navigate"));
        expect(toolNames.indexOf("plan")).toBeLessThan(toolNames.indexOf("browser.navigate"));
        expect(toolNames.indexOf(READ_TOOL)).toBeLessThan(toolNames.indexOf("browser.navigate"));
        expect(harness.mcp.readInputs).toHaveLength(1);
      }

      const callSummary = {
        mutationCalls: harness.mcp.mutationInputs.length,
        verificationCalls: harness.mcp.verificationInputs.length,
      };
      expect(callSummary).toMatchObject({
        mutationCalls: scenario.expectedMutationCalls,
        verificationCalls: scenario.expectedVerificationCalls,
      });
      expect(harness.mcp.timeline).toEqual(scenario.expectedTimeline);
      expect(response!.finalOutcome?.status).toBe(scenario.expectedFinalOutcome);

      // Temporary characterization of the current Mission protocol tax. Later
      // migration commits intentionally update these counts while preserving
      // the mutation, verification, approval, and secret-isolation assertions.
      expect({
        providerRequests: harness.providerRequests.length,
        toolExecutions: response!.toolExecutions.length,
        planExecutions: toolNames.filter((name) => name === "plan").length,
        substantiveExecutions: toolNames.filter((name) => name !== "plan").length,
      }).toEqual({
        providerRequests: scenario.expectedProviderRequests,
        toolExecutions: scenario.expectedToolExecutions,
        planExecutions: scenario.expectedPlanExecutions,
        substantiveExecutions: scenario.expectedToolExecutions - scenario.expectedPlanExecutions,
      });

      if (scenario.expectedMutationCalls === 1) {
        expect(harness.mcp.mutationInputs[0]).toMatchObject({
          targetId: TARGET_ID,
          settings: harness.mcp.initialSettings,
          values: [
            { name: "application-id", value: FIRST_PROTECTED_VALUE },
            { name: "application-secret", value: SECOND_PROTECTED_VALUE },
          ],
        });
        expect(harness.mcp.state().settings).toEqual(harness.mcp.initialSettings);
      } else {
        expect(harness.mcp.state()).toEqual({
          targetId: TARGET_ID,
          settings: harness.mcp.initialSettings,
          values: [],
        });
      }

      if (scenario.expectCompleted) {
        expect(harness.authorizationRequests).toHaveLength(1);
        expect(harness.authorizationRequests[0]).toMatchObject({
          transferGroup: { items: [{}, {}] },
        });
        expect(toolNames.filter((name) => name === MUTATION_TOOL)).toHaveLength(1);
        expect(toolNames.filter((name) => name === VERIFY_TOOL)).toHaveLength(1);
        expect(toolNames.filter((name) => name === "browser.snapshot")).toHaveLength(0);
        expect(toolNames.filter((name) => name !== "plan")).toEqual([
          READ_TOOL,
          "browser.navigate",
          MUTATION_TOOL,
          VERIFY_TOOL,
        ]);
        expect(mission).toMatchObject({
          status: "completed",
          capabilityPreflight: { status: "ready" },
          items: [
            { id: "inspect-target", status: "completed", evidenceCallIds: ["journey-call-2"] },
            { id: "bind-sources", status: "completed", evidenceCallIds: ["journey-call-4"] },
            { id: "update-target", status: "completed", evidenceCallIds: ["journey-call-6"] },
            { id: "verify-target", status: "completed", evidenceCallIds: ["journey-call-8"] },
          ],
        });
        expect(mission?.items[3]?.evidence?.[0]).toMatchObject({ tool: VERIFY_TOOL, outcome: "success" });
        expect(response!.finalOutcome?.confirmedActions).toEqual([
          expect.objectContaining({
            tool: MUTATION_TOOL,
            status: "confirmed",
            verification: "verified",
          }),
        ]);
        expect(response!.text).not.toContain("Mission is incomplete");
      } else {
        expect(mission?.status).not.toBe("completed");
        expect(response!.text).not.toContain("Provisioning completed and independently verified.");
        if (scenario.expectedMutationCalls === 0) {
          expect(response!.finalOutcome?.confirmedActions).toEqual([]);
        }
        if (scenario.failVerification === true) {
          expect(response!.finalOutcome?.confirmedActions).toEqual([
            expect.objectContaining({
              tool: MUTATION_TOOL,
              status: "confirmed",
              verification: "not_verified",
            }),
          ]);
        }
      }

      if (scenario.approval === "denied") expect(harness.authorizationRequests).toHaveLength(1);
      if (scenario.undeclaredDestination) expect(harness.authorizationRequests).toHaveLength(0);
      if (scenario.changeSourceAfterApproval) expect(harness.authorizationRequests).toHaveLength(1);

      await harness.runtime.dispose();
      disposed = true;
      const leakSurfaces = {
        messages,
        events,
        mission,
        providerRequests: harness.providerRequests,
        providerResponses: harness.providerResponses,
        toolResults: response!.toolExecutions,
        runtimeEvents: harness.runtimeEvents,
        trajectoryRecords: harness.trajectoryRecords,
        authorizationRequests: harness.authorizationRequests,
        logs: harness.logs,
        response,
      };
      const serialized = inspect(leakSurfaces, { depth: 30, maxArrayLength: null });
      for (const forbidden of FORBIDDEN_VALUES) expect(serialized).not.toContain(forbidden);
    } finally {
      if (!disposed) await harness.runtime.dispose();
    }
  });
});

async function createJourneyHarness(scenario: JourneyScenario) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "estacoda-cross-system-acceptance-"));
  tempRoots.push(workspaceRoot);
  const sessionId = `cross-system-${scenario.name.replace(/\W+/gu, "-").toLowerCase()}`;
  const socket = new FakeCdpAuthPortalSocket();
  showProtectedProvisioningValues(socket, [FIRST_PROTECTED_VALUE, SECOND_PROTECTED_VALUE]);
  const mcp = new FakeApiManagementMcp({
    exposeMutation: true,
    failVerification: scenario.failVerification,
    echoProtectedValues: true,
  });
  vi.stubGlobal("fetch", mcp.fetch);

  const providerRequests: ProviderRequest[] = [];
  const providerResponses: ProviderResponse[] = [];
  const runtimeEvents: unknown[] = [];
  const trajectoryRecords: unknown[] = [];
  const authorizationRequests: Array<Parameters<SecureInputAuthorizationHandler>[0]> = [];
  const logs: unknown[] = [];
  for (const method of ["log", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push({ method, args }); });
  }
  const originalTrajectoryRecord = TrajectoryRecorder.prototype.record;
  vi.spyOn(TrajectoryRecorder.prototype, "record").mockImplementation(function (
    this: TrajectoryRecorder,
    kind,
    data,
  ) {
    trajectoryRecords.push({ kind, data: structuredClone(data) });
    return originalTrajectoryRecord.call(this, kind, data);
  });

  const providerRegistry = new ProviderRegistry();
  const providerScript = createProviderScript({
    scenario,
    sessionId: `${sessionId}:main`,
    providerRequests,
    providerResponses,
  });
  const provider: ProviderAdapter = {
    id: model.provider,
    name: "Governed provisioning acceptance provider",
    executable: true,
    health: () => ({ available: true }),
    listModels: () => [model],
    complete: async (request) => providerScript(request),
  };
  providerRegistry.register(provider);

  const browserBackend = createSupervisedLocalCdpBrowserBackend({
    cdpUrl: "http://127.0.0.1:9222",
    fetch: createFakeCdpFetch(),
    webSocketFactory: () => socket,
    resolveHostname: () => ["93.184.216.34"],
    settling: { pollIntervalMs: 5, stableWindowMs: 10, minimumObservationMs: 10 },
  });
  const runtime = await createRuntime({
    tokens: resolveTokens("standard", "dark", "kemetBlue"),
    model,
    primaryModelRoute: route,
    providerRegistry,
    workspaceRoot,
    homeDir: workspaceRoot,
    localSkillsRoot: join(workspaceRoot, "skills"),
    sessionId,
    browserBackend,
    mcpServers: {
      [SERVER_ID]: {
        transport: "http",
        url: FAKE_API_MANAGEMENT_MCP_URL,
        excludeTools: scenario.exposeMutation === false ? ["updateState"] : undefined,
        toolRiskClasses: {
          readState: "read-only-network",
          updateState: "external-side-effect",
          verifyState: "read-only-network",
        },
        protectedToolArguments: {
          updateState: {
            paths: ["/values/*/value"],
            handling: { persistence: "destination-managed", sharing: "workspace" },
            groupedDelivery: true,
            browserRelay: true,
          },
        },
        toolVerificationRelationships: {
          verifyState: ["updateState"],
        },
      },
    },
    workspaceTrusted: true,
    securityPolicy: { decide: () => "allow" },
    executionControls: {
      providerBudgets: {
        maxProviderIterations: 12,
        maxProviderToolCalls: 10,
        maxRepeatedBrowserObservations: 2,
        maxProviderWallClockMs: 15_000,
        finalizationReserveMs: 0,
      },
    },
  });
  const secureInputHandler = runtime.createSecureInputRequestHandler!({
    collect: async () => { throw new Error("The protected browser-source journey must not ask for plaintext input."); },
    authorize: async (request) => {
      authorizationRequests.push(structuredClone(request));
      if (scenario.changeSourceAfterApproval) {
        replaceProtectedProvisioningValue(socket, 1, CHANGED_PROTECTED_VALUE);
      }
      return scenario.approval ?? "approved";
    },
  });

  return {
    runtime,
    socket,
    mcp,
    secureInputHandler,
    providerRequests,
    providerResponses,
    runtimeEvents,
    trajectoryRecords,
    authorizationRequests,
    logs,
  };
}

function createProviderScript(input: {
  scenario: JourneyScenario;
  sessionId: string;
  providerRequests: ProviderRequest[];
  providerResponses: ProviderResponse[];
}) {
  let phase = 0;
  let nextCallId = 1;
  return (request: ProviderRequest): ProviderResponse => {
    input.providerRequests.push(structuredClone(request));
    const call = (name: string, args: Record<string, unknown>) => toolCallResponse(
      `journey-call-${nextCallId++}`,
      name,
      args,
    );
    let response: ProviderResponse;
    switch (phase++) {
      case 0:
        response = call("plan", initialPlan());
        break;
      case 1:
        response = call(READ_TOOL, { targetId: TARGET_ID });
        break;
      case 2:
        response = call("plan", {
          operation: "merge",
          items: [
            { id: "inspect-target", status: "completed", evidenceCallIds: ["journey-call-2"] },
            { id: "bind-sources", status: "in_progress" },
          ],
        });
        break;
      case 3:
        response = call("browser.navigate", { url: FAKE_DEVELOPER_PORTAL_URL });
        break;
      case 4:
        response = call("plan", {
          operation: "merge",
          items: [
            { id: "bind-sources", status: "completed", evidenceCallIds: ["journey-call-4"] },
            { id: "update-target", status: "in_progress" },
          ],
        });
        break;
      case 5:
        response = call(MUTATION_TOOL, mutationInput(request, input.sessionId, input.scenario.undeclaredDestination === true));
        break;
      case 6:
        if (input.scenario.approval === "denied" || input.scenario.changeSourceAfterApproval === true ||
            input.scenario.undeclaredDestination === true) {
          response = call("plan", {
            operation: "merge",
            items: [{
              id: "update-target",
              status: "blocked",
              blocker: { kind: "external_state", summary: "The protected destination mutation did not complete." },
            }],
          });
        } else {
          response = call("plan", {
            operation: "merge",
            items: [
              { id: "update-target", status: "completed", evidenceCallIds: ["journey-call-6"] },
              { id: "verify-target", status: "in_progress" },
            ],
          });
        }
        break;
      case 7:
        response = input.scenario.approval === "denied" || input.scenario.changeSourceAfterApproval === true ||
          input.scenario.undeclaredDestination === true
          ? finalResponse("Provisioning could not safely complete.")
          : call(VERIFY_TOOL, { targetId: TARGET_ID });
        break;
      case 8:
        response = input.scenario.failVerification === true
          ? call("plan", {
              operation: "merge",
              items: [{
                id: "verify-target",
                status: "blocked",
                blocker: { kind: "external_state", summary: "Independent destination verification failed." },
              }],
            })
          : call("plan", {
              operation: "merge",
              items: [{ id: "verify-target", status: "completed", evidenceCallIds: ["journey-call-8"] }],
            });
        break;
      default:
        response = finalResponse(input.scenario.failVerification === true
          ? "The mutation could not be independently verified."
          : "Provisioning completed and independently verified.");
    }
    input.providerResponses.push(structuredClone(response));
    return response;
  };
}

function initialPlan(): Record<string, unknown> {
  return {
    operation: "write",
    objective: "Provision protected browser values into a managed destination and verify the result",
    items: [
      { id: "inspect-target", content: "Read and preserve existing destination state", status: "in_progress" },
      { id: "bind-sources", content: "Open the portal and identify both protected sources", status: "pending" },
      { id: "update-target", content: "Apply both protected values in one destination mutation", status: "pending" },
      { id: "verify-target", content: "Read back and verify the changed destination state", status: "pending" },
    ],
    requirements: [
      { id: "source-read", itemId: "bind-sources", tool: "browser.navigate", capability: "read" },
      { id: "destination-read", itemId: "inspect-target", tool: READ_TOOL, capability: "read" },
      {
        id: "destination-mutation",
        itemId: "update-target",
        tool: MUTATION_TOOL,
        capability: "mutate",
        requiresProtectedInput: true,
        protectedSource: "browser",
      },
      { id: "destination-verification", itemId: "verify-target", tool: VERIFY_TOOL, capability: "verify" },
    ],
  };
}

function mutationInput(
  request: ProviderRequest,
  sessionId: string,
  undeclaredDestination: boolean,
): Record<string, unknown> {
  const identity = latestIdentity(request);
  const source = (ref: "@e1" | "@e2") => ({
    type: "browser-field",
    sessionId,
    ref,
    identity,
    expectedOrigin: FAKE_DEVELOPER_PORTAL_ORIGIN,
    tabRef: "@t1",
    frameId: "main-frame",
  });
  const protectedInput = (kind: "api-key" | "client-secret", ref: "@e1" | "@e2") => ({
    protectedInput: {
      kind,
      purpose: "Provision one protected value into the managed destination",
      retention: "use-once",
      source: source(ref),
    },
  });
  return {
    targetId: TARGET_ID,
    settings: { region: "test-region-1", retryLimit: 4, labels: ["existing", "preserve"] },
    values: [
      { name: "application-id", value: protectedInput("api-key", "@e1") },
      ...(undeclaredDestination
        ? [{ name: "application-secret", value: "preserve-until-protected-transfer" }]
        : [{ name: "application-secret", value: protectedInput("client-secret", "@e2") }]),
    ],
    ...(undeclaredDestination ? { unreviewed: protectedInput("client-secret", "@e2") } : {}),
  };
}

function latestIdentity(request: ProviderRequest): {
  documentEpoch: number;
  actionRevision: number;
  observationId: number;
} {
  const text = request.messages.map((message) =>
    typeof message.content === "string" ? message.content : JSON.stringify(message.content)
  ).join("\n");
  const matches = [
    ...text.matchAll(/documentEpoch=(\d+)\s+actionRevision=(\d+)\s+observationId=(\d+)/gu),
    ...text.matchAll(/"documentEpoch":(\d+),"actionRevision":(\d+),"observationId":(\d+)/gu),
  ].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
  const latest = matches.at(-1);
  if (latest === undefined) throw new Error("The acceptance provider did not receive a browser identity.");
  return {
    documentEpoch: Number(latest[1]),
    actionRevision: Number(latest[2]),
    observationId: Number(latest[3]),
  };
}

function firstRequestToolNames(request: ProviderRequest | undefined): string[] {
  if (request === undefined || !Array.isArray(request.tools)) return [];
  return request.tools.flatMap((tool) => {
    if (typeof tool !== "object" || tool === null || Array.isArray(tool)) return [];
    const fn = (tool as { function?: { name?: unknown } }).function;
    return typeof fn?.name === "string" ? [fn.name] : [];
  });
}

function providerToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/gu, "_");
}

function toolCallResponse(id: string, name: string, args: Record<string, unknown>): ProviderResponse {
  return {
    ok: true,
    content: "",
    finishReason: "tool_calls",
    model: model.id,
    provider: model.provider,
    raw: {
      choices: [{ message: { tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] } }],
    },
  };
}

function finalResponse(content: string): ProviderResponse {
  return {
    ok: true,
    content,
    finishReason: "stop",
    model: model.id,
    provider: model.provider,
  };
}
