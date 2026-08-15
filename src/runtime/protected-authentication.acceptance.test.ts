import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupervisedLocalCdpBrowserBackend } from "../browser/supervised-local-cdp-backend.js";
import type {
  ModelProfile,
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  ResolvedModelRoute,
} from "../contracts/provider.js";
import type {
  GroupedSecureInputRequestHandler,
  SecureInputCollectionContext,
  SecureInputRequestSnapshot,
} from "../contracts/secure-input.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import {
  FakeCdpAuthPortalSocket,
  createFakeCdpFetch,
  showAuthenticatedHome,
  showCredentialLoginPage,
  showOtpChallengePage,
} from "../test/fakes/fake-cdp-auth-portal.js";
import { resolveTokens } from "../theme/token-resolver.js";
import { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import { createRuntime, type Runtime } from "./create-runtime.js";

const ACCOUNT_SECRET = "acceptance-account@example.com";
const PASSWORD_SECRET = "acceptance-password-sentinel";
const OTP_SECRET = "731942";
const SECRETS = [ACCOUNT_SECRET, PASSWORD_SECRET, OTP_SECRET] as const;
const PORTAL_ORIGIN = "https://93.184.216.34";

const model: ModelProfile = {
  id: "protected-auth-acceptance-model",
  provider: "protected-auth-acceptance",
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

type CredentialOutcome = "otp" | "incorrect" | "error" | "remains";
type SubmissionMode = "manual" | "automatic";
type OtpOutcome = "authenticated" | "rejected";

type AcceptanceScenario = {
  name: string;
  credentialMode?: SubmissionMode;
  credentialOutcome?: CredentialOutcome;
  otpMode?: SubmissionMode;
  otpOutcome?: OtpOutcome;
  otpSameDocument?: boolean;
  cancelCollection?: boolean;
  changeSubmitDuringCollection?: boolean;
  closeBrowserDuringCollection?: boolean;
  preexistingSignOut?: boolean;
  authenticated: boolean;
  expectedCredentialSubmits: number;
  expectedOtpPrompts: number;
  expectedOtpSubmits: number;
};

const scenarios: AcceptanceScenario[] = [
  {
    name: "credentials manual submit then OTP manual submit reaches the authenticated page",
    authenticated: true,
    expectedCredentialSubmits: 1,
    expectedOtpPrompts: 1,
    expectedOtpSubmits: 1,
  },
  {
    name: "credentials automatically submit into the OTP challenge",
    credentialMode: "automatic",
    authenticated: true,
    expectedCredentialSubmits: 1,
    expectedOtpPrompts: 1,
    expectedOtpSubmits: 1,
  },
  {
    name: "OTP automatically submits into the authenticated page",
    otpMode: "automatic",
    authenticated: true,
    expectedCredentialSubmits: 1,
    expectedOtpPrompts: 1,
    expectedOtpSubmits: 1,
  },
  {
    name: "incorrect password keeps authentication unconfirmed",
    credentialOutcome: "incorrect",
    authenticated: false,
    expectedCredentialSubmits: 1,
    expectedOtpPrompts: 0,
    expectedOtpSubmits: 0,
  },
  {
    name: "expired or rejected OTP keeps authentication unconfirmed",
    otpOutcome: "rejected",
    authenticated: false,
    expectedCredentialSubmits: 1,
    expectedOtpPrompts: 1,
    expectedOtpSubmits: 1,
  },
  {
    name: "same-document OTP departure settles without a navigation",
    otpSameDocument: true,
    authenticated: true,
    expectedCredentialSubmits: 1,
    expectedOtpPrompts: 1,
    expectedOtpSubmits: 1,
  },
  {
    name: "full-navigation credential and OTP transitions settle",
    authenticated: true,
    expectedCredentialSubmits: 1,
    expectedOtpPrompts: 1,
    expectedOtpSubmits: 1,
  },
  {
    name: "user cancellation stops before credential delivery or submission",
    cancelCollection: true,
    authenticated: false,
    expectedCredentialSubmits: 0,
    expectedOtpPrompts: 0,
    expectedOtpSubmits: 0,
  },
  {
    name: "a submit control changed during collection fails re-verification",
    changeSubmitDuringCollection: true,
    authenticated: false,
    expectedCredentialSubmits: 0,
    expectedOtpPrompts: 0,
    expectedOtpSubmits: 0,
  },
  {
    name: "browser closure during secure input fails without exposing values",
    closeBrowserDuringCollection: true,
    authenticated: false,
    expectedCredentialSubmits: 0,
    expectedOtpPrompts: 0,
    expectedOtpSubmits: 0,
  },
  {
    name: "error-page navigation does not become an authentication claim",
    credentialOutcome: "error",
    authenticated: false,
    expectedCredentialSubmits: 1,
    expectedOtpPrompts: 0,
    expectedOtpSubmits: 0,
  },
  {
    name: "a pre-existing Sign out link does not bypass credential collection",
    preexistingSignOut: true,
    authenticated: true,
    expectedCredentialSubmits: 1,
    expectedOtpPrompts: 1,
    expectedOtpSubmits: 1,
  },
  {
    name: "a protected form remaining after submission stays unconfirmed",
    credentialOutcome: "remains",
    authenticated: false,
    expectedCredentialSubmits: 1,
    expectedOtpPrompts: 0,
    expectedOtpSubmits: 0,
  },
];

const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (tempRoots.length > 0) {
    await rm(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe("protected authentication journey acceptance", () => {
  it.each(scenarios)("$name", async (scenario) => {
    const harness = await createAcceptanceHarness(scenario);
    let response: Awaited<ReturnType<Runtime["handle"]>> | undefined;
    let thrown: unknown;
    let disposed = false;

    try {
      response = await harness.runtime.handle({
        text: "Continue the browser task.",
        channel: "cli",
        trustedWorkspace: true,
        onSecureInputRequest: harness.secureInputHandler,
      });
    } catch (error) {
      thrown = error;
    }

    try {
      expect(thrown).toBeUndefined();
      expect(response).toBeDefined();
      expect(harness.groupedCredentialPrompts).toBe(1);
      expect(harness.otpPrompts).toBe(scenario.expectedOtpPrompts);
      expect(harness.credentialSubmits).toBe(scenario.expectedCredentialSubmits);
      expect(harness.otpSubmits).toBe(scenario.expectedOtpSubmits);
      expect(harness.timeline.filter((event) => event.startsWith("credential-delivery-"))).toHaveLength(
        scenario.expectedCredentialSubmits === 1 ? 2 : 0,
      );
      expect(harness.timeline.filter((event) => event === "otp-delivery")).toHaveLength(
        scenario.expectedOtpSubmits,
      );
      const expectedLocalClicks = (
        scenario.expectedCredentialSubmits === 1 && (scenario.credentialMode ?? "manual") === "manual" ? 1 : 0
      ) + (
        scenario.expectedOtpSubmits === 1 && (scenario.otpMode ?? "manual") === "manual" ? 1 : 0
      );
      expect(harness.socket.sent.filter((message) =>
        message.method === "Runtime.callFunctionOn" &&
        String(message.params?.functionDeclaration).includes("this.click();")
      )).toHaveLength(expectedLocalClicks);

      const toolNames = response!.toolExecutions.map((execution) => execution.tool.name);
      expect(toolNames.filter((name) => name === "browser.fill_protected_form")).toHaveLength(1);
      expect(toolNames.filter((name) => name === "browser.type")).toHaveLength(scenario.expectedOtpPrompts);
      expect(JSON.stringify(response!.toolExecutions)).not.toContain("stale-browser-ref");
      expect(harness.providerRequests.length).toBeGreaterThanOrEqual(2);

      if (scenario.expectedCredentialSubmits === 1) {
        assertNoProviderSeam(harness.timeline, "credential-delivery-2", [
          "credential-submit",
          "credential-auto-submit",
        ]);
      }
      if (scenario.expectedOtpSubmits === 1) {
        assertNoProviderSeam(harness.timeline, "otp-delivery", ["otp-submit", "otp-auto-submit"]);
      }

      if (scenario.authenticated) {
        expect(response!.text).toContain("Authentication confirmed from the authenticated account page.");
        expect(response!.text).not.toContain("could not be confirmed");
        const usable = await harness.runtime.executeTool?.({
          tool: "browser.snapshot",
          toolInput: {},
        });
        expect(usable?.result).toMatchObject({ ok: true });
        expect(usable?.result?.content).toContain("My profile");
        expect(JSON.stringify(response)).not.toMatch(/browser observation guard|repeated browser observations/iu);
      } else {
        expect(response!.text).toContain("Authentication could not be confirmed");
        expect(response!.text).not.toContain("Authentication confirmed from the authenticated account page.");
      }

      const messages = await harness.runtime.sessionDb.listMessages(harness.runtime.sessionId);
      const events = await harness.runtime.sessionDb.listEvents(harness.runtime.sessionId);
      await harness.runtime.dispose();
      disposed = true;
      const leakSurfaces = {
        providerRequests: harness.providerRequests,
        response,
        messages,
        events,
        trajectoryRecords: harness.trajectoryRecords,
        exceptions: harness.exceptions,
        logs: harness.logs,
      };
      const serialized = inspect(leakSurfaces, { depth: 20, maxArrayLength: null });
      for (const secret of SECRETS) expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain("stale-browser-ref");
      expect(JSON.stringify(events)).not.toContain("repeated-browser-observations");

      expect(harness.collectedKinds.filter((kind) => kind === "account-identifier")).toHaveLength(1);
      if (!scenario.cancelCollection) {
        expect(harness.collectedKinds.filter((kind) => kind === "password")).toHaveLength(1);
      }
      expect(harness.collectedKinds.filter((kind) => kind === "one-time-code")).toHaveLength(
        scenario.expectedOtpPrompts,
      );
    } finally {
      if (!disposed) await harness.runtime.dispose();
    }
  });
});

async function createAcceptanceHarness(scenario: AcceptanceScenario) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "estacoda-protected-auth-acceptance-"));
  tempRoots.push(workspaceRoot);
  const socket = new FakeCdpAuthPortalSocket();
  showCredentialLoginPage(socket);
  socket.snapshot.url = `${PORTAL_ORIGIN}/login`;
  if (scenario.preexistingSignOut) {
    socket.snapshot.elements.push({ ref: "@e4", role: "link", name: "Sign out" });
  }

  const timeline: string[] = [];
  const exceptions: unknown[] = [];
  const logs: unknown[] = [];
  const trajectoryRecords: unknown[] = [];
  const providerRequests: ProviderRequest[] = [];
  const collectedKinds: string[] = [];
  let credentialDeliveries = 0;
  let credentialSubmits = 0;
  let otpSubmits = 0;
  let groupedCredentialPrompts = 0;
  let otpPrompts = 0;

  for (const method of ["log", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push({ method, args });
    });
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

  const activateOtpChallenge = () => {
    showOtpChallengePage(socket);
    socket.snapshot.url = `${PORTAL_ORIGIN}/challenge`;
    socket.documentCurrent = false;
    socket.onProtectedDelivery = () => {
      timeline.push("otp-delivery");
      if ((scenario.otpMode ?? "manual") === "automatic") {
        otpSubmits += 1;
        timeline.push("otp-auto-submit");
        completeOtp();
      }
    };
    socket.onProtectedSubmit = () => {
      otpSubmits += 1;
      timeline.push("otp-submit");
      completeOtp();
    };
  };

  const completeOtp = () => {
    if ((scenario.otpOutcome ?? "authenticated") === "rejected") {
      socket.snapshot.text = "The verification code expired or was rejected.";
      return;
    }
    showAuthenticatedHome(socket, { documentChanged: !scenario.otpSameDocument });
    socket.snapshot.url = `${PORTAL_ORIGIN}/home`;
  };

  const completeCredentialSubmission = () => {
    switch (scenario.credentialOutcome ?? "otp") {
      case "otp":
        activateOtpChallenge();
        break;
      case "incorrect":
        socket.snapshot.text = "The email or password is incorrect.";
        break;
      case "error":
        socket.documentCurrent = false;
        socket.protectedFieldInspection.current = false;
        socket.protectedFieldInspection.conflictCount = 0;
        socket.protectedSubmitInspection.current = false;
        socket.snapshot = {
          url: `${PORTAL_ORIGIN}/error`,
          title: "Authentication error",
          text: "Authentication service unavailable.",
          elements: [{ ref: "@e1", role: "link", name: "Return to sign in" }],
        };
        break;
      case "remains":
        break;
    }
  };

  socket.onProtectedDelivery = () => {
    credentialDeliveries += 1;
    timeline.push(`credential-delivery-${credentialDeliveries}`);
    if (credentialDeliveries === 2 && (scenario.credentialMode ?? "manual") === "automatic") {
      credentialSubmits += 1;
      timeline.push("credential-auto-submit");
      completeCredentialSubmission();
    }
  };
  socket.onProtectedSubmit = () => {
    credentialSubmits += 1;
    timeline.push("credential-submit");
    completeCredentialSubmission();
  };

  const browserBackend = createSupervisedLocalCdpBrowserBackend({
    cdpUrl: "http://127.0.0.1:9222",
    fetch: createFakeCdpFetch(),
    webSocketFactory: () => socket,
    resolveHostname: () => ["93.184.216.34"],
    settling: { pollIntervalMs: 5, stableWindowMs: 10, minimumObservationMs: 10 },
  });
  const providerRegistry = new ProviderRegistry();
  const providerScript = createProviderScript({ socket, timeline, providerRequests });
  const provider: ProviderAdapter = {
    id: model.provider,
    name: "Protected authentication acceptance provider",
    executable: true,
    health: () => ({ available: true }),
    listModels: () => [model],
    complete: async (request) => providerScript(request),
  };
  providerRegistry.register(provider);

  const runtime = await createRuntime({
    tokens: resolveTokens("standard", "dark", "kemetBlue"),
    model,
    primaryModelRoute: route,
    providerRegistry,
    workspaceRoot,
    homeDir: workspaceRoot,
    localSkillsRoot: join(workspaceRoot, "skills"),
    sessionId: `protected-auth-${scenario.name.replace(/\W+/gu, "-").toLowerCase()}`,
    browserBackend,
    workspaceTrusted: true,
    securityPolicy: { decide: () => "allow" },
    executionControls: {
      providerBudgets: {
        maxProviderIterations: 8,
        maxProviderToolCalls: 6,
        maxRepeatedBrowserObservations: 3,
        maxProviderWallClockMs: 10_000,
        finalizationReserveMs: 0,
      },
    },
  });

  const baseHandler = runtime.createSecureInputRequestHandler!({
    collect: async (
      request: SecureInputRequestSnapshot,
      _signal: AbortSignal,
      context: SecureInputCollectionContext,
    ) => {
      collectedKinds.push(request.request.kind);
      if (scenario.cancelCollection && context.group?.index === 1) return { status: "cancelled" as const };
      if (context.group?.index === 1 && scenario.changeSubmitDuringCollection) {
        socket.protectedSubmitInspection.current = false;
      }
      if (context.group?.index === 1 && scenario.closeBrowserDuringCollection) {
        socket.failMethods.set("Runtime.callFunctionOn", "Browser closed during secure input.");
        socket.close();
      }
      const value = request.request.kind === "account-identifier"
        ? ACCOUNT_SECRET
        : request.request.kind === "password"
          ? PASSWORD_SECRET
          : OTP_SECRET;
      return { status: "provided" as const, value: new TextEncoder().encode(value) };
    },
  });
  const groupedBaseHandler = baseHandler as GroupedSecureInputRequestHandler;
  const secureInputHandler = (async (request, consume) => {
    otpPrompts += request.kind === "one-time-code" ? 1 : 0;
    try {
      return await groupedBaseHandler(request, consume);
    } catch (error) {
      exceptions.push(error);
      throw error;
    }
  }) as GroupedSecureInputRequestHandler;
  secureInputHandler.requestGroup = async (request) => {
    groupedCredentialPrompts += 1;
    try {
      return await groupedBaseHandler.requestGroup(request);
    } catch (error) {
      exceptions.push(error);
      throw error;
    }
  };

  return {
    runtime,
    socket,
    timeline,
    providerRequests,
    trajectoryRecords,
    exceptions,
    logs,
    collectedKinds,
    secureInputHandler,
    get groupedCredentialPrompts() { return groupedCredentialPrompts; },
    get otpPrompts() { return otpPrompts; },
    get credentialSubmits() { return credentialSubmits; },
    get otpSubmits() { return otpSubmits; },
  };
}

function createProviderScript(input: {
  socket: FakeCdpAuthPortalSocket;
  timeline: string[];
  providerRequests: ProviderRequest[];
}) {
  let navigateRequested = false;
  let credentialsRequested = false;
  let otpRequested = false;
  let authenticatedSnapshotRequested = false;
  let nextCallId = 1;

  return (request: ProviderRequest): ProviderResponse => {
    input.timeline.push("provider");
    input.providerRequests.push(structuredClone(request));
    const call = (name: string, args: Record<string, unknown>) => toolCallResponse(
      `acceptance-call-${nextCallId++}`,
      name,
      args,
    );

    if (!navigateRequested) {
      navigateRequested = true;
      return call("browser.navigate", { url: `${PORTAL_ORIGIN}/login` });
    }
    if (!credentialsRequested) {
      credentialsRequested = true;
      return call("browser.fill_protected_form", {
        purpose: "Sign in to the test portal",
        revision: latestRevision(request),
        tabRef: "@t1",
        submitRef: "@e3",
        fields: [
          { id: "account", ref: "@e1", kind: "account-identifier" },
          { id: "password", ref: "@e2", kind: "password" },
        ],
      });
    }
    if (input.socket.snapshot.title === "Verify account" && !otpRequested) {
      input.socket.documentCurrent = true;
      otpRequested = true;
      return call("browser.type", {
        ref: "@e1",
        revision: latestRevision(request),
        tabRef: "@t1",
        submitRef: "@e2",
        protectedInput: {
          kind: "one-time-code",
          purpose: "Complete test portal authentication",
        },
      });
    }
    if (input.socket.snapshot.title === "Account home" && !authenticatedSnapshotRequested) {
      authenticatedSnapshotRequested = true;
      return call("browser.snapshot", {});
    }
    return finalResponse(
      input.socket.snapshot.title === "Account home" && authenticatedSnapshotRequested
        ? "Authentication confirmed from the authenticated account page."
        : "Authentication could not be confirmed from the settled browser state.",
    );
  };
}

function latestRevision(request: ProviderRequest): number {
  const text = request.messages.map((message) =>
    typeof message.content === "string" ? message.content : JSON.stringify(message.content)
  ).join("\n");
  const matches = [
    ...text.matchAll(/Revision:\s*(?:\d+\s*→\s*)?(\d+)/gu),
    ...text.matchAll(/\brevision[=:]\s*(\d+)/giu),
  ].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
  const revision = Math.max(...matches.map((match) => Number(match[1])).filter((value) => value > 0));
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw new Error("The acceptance provider did not receive a current browser revision.");
  }
  return revision;
}

function toolCallResponse(
  id: string,
  name: string,
  args: Record<string, unknown>,
): ProviderResponse {
  return {
    ok: true,
    content: "",
    finishReason: "tool_calls",
    model: model.id,
    provider: model.provider,
    raw: {
      choices: [{
        message: {
          tool_calls: [{
            id,
            function: { name, arguments: JSON.stringify(args) },
          }],
        },
      }],
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

function assertNoProviderSeam(
  timeline: readonly string[],
  delivery: string,
  submissions: readonly string[],
): void {
  const deliveryIndex = timeline.lastIndexOf(delivery);
  const submissionIndex = timeline.findIndex((event, index) =>
    index > deliveryIndex && submissions.includes(event)
  );
  expect(deliveryIndex).toBeGreaterThanOrEqual(0);
  expect(submissionIndex).toBeGreaterThan(deliveryIndex);
  expect(timeline.slice(deliveryIndex + 1, submissionIndex)).not.toContain("provider");
}
