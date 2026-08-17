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
import { latestExecutionPlanSnapshot } from "../session/execution-plan-state.js";
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
  cancelFirstCollectionOnly?: boolean;
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

      const messages = await harness.runtime.sessionDb.listMessages(harness.runtime.sessionId);
      const events = await harness.runtime.sessionDb.listEvents(harness.runtime.sessionId);
      const mission = latestExecutionPlanSnapshot(events);
      expect(mission).toBeDefined();
      const authenticationAssessments = events.filter((event) => event.kind === "authentication-evidence-assessed");

      if (scenario.authenticated) {
        expect(response!.text).toContain("Authentication confirmed from the authenticated account page.");
        expect(response!.text).not.toContain("The Mission is incomplete.");
        expect(mission).toMatchObject({
          status: "completed",
          items: [
            { id: "authentication.credentials", status: "completed" },
            {
              id: "authentication.verify",
              status: "completed",
              evidenceCallIds: ["acceptance-call-3"],
            },
            { id: "authentication.challenge", status: "completed" },
          ],
        });
        expect(authenticationAssessments).toContainEqual(expect.objectContaining({
          outcome: "verified",
          reason: "authenticated-evidence-observed",
          submissionToolCallId: "acceptance-call-3",
          evidenceToolCallId: "acceptance-call-3",
          challengeDeparted: true,
          stateTransitionObserved: true,
          postSubmitEvidence: true,
          navigationInterrupted: false,
          sensitiveInputActive: false,
        }));
        const usable = await harness.runtime.executeTool?.({
          tool: "browser.snapshot",
          toolInput: {},
        });
        expect(usable?.result).toMatchObject({ ok: true });
        expect(usable?.result?.content).toContain("My profile");
        expect(JSON.stringify(response)).not.toMatch(/browser observation guard|repeated browser observations/iu);
      } else {
        expect(response!.text).not.toContain("Authentication confirmed from the authenticated account page.");
        expect(authenticationAssessments.some((event) => event.outcome === "verified")).toBe(false);
        expect(mission!.items.some((item) => item.status === "blocked" && item.blocker !== undefined)).toBe(true);
        if (scenario.cancelCollection) {
          expect(response!.text).toContain("The Mission needs your input before it can continue");
        } else {
          expect(response!.text).toContain("The Mission is incomplete.");
        }
      }

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

  it("recovers a partially blocked Mission when the user corrects the fictional portal", async () => {
    const harness = await createAcceptanceHarness({
      name: "corrected fictional portal recovery",
      cancelFirstCollectionOnly: true,
      authenticated: true,
      expectedCredentialSubmits: 1,
      expectedOtpPrompts: 1,
      expectedOtpSubmits: 1,
    });
    const legacyUrl = `${PORTAL_ORIGIN}/legacy/login`;
    const correctUrl = `${PORTAL_ORIGIN}/current/login`;
    harness.resetProviderAttempt(legacyUrl);

    try {
      const first = await harness.runtime.handle({
        text: "Pull up a browser and get us logged into our fictional developer account.",
        channel: "cli",
        trustedWorkspace: true,
        onSecureInputRequest: harness.secureInputHandler,
      });
      expect(first.text).toContain("The Mission needs your input before it can continue");
      expect(harness.providerRequests[0] === undefined ? [] : providerToolNames(harness.providerRequests[0])).toContain("browser_navigate");
      expect(first.toolExecutions.find((execution) => execution.tool.name === "browser.navigate")?.input).toMatchObject({
        url: legacyUrl,
      });
      expect(latestExecutionPlanSnapshot(await harness.runtime.sessionDb.listEvents(harness.runtime.sessionId))).toMatchObject({
        status: "active",
        items: expect.arrayContaining([
          expect.objectContaining({
            id: "execute",
            content: "Submit the required authentication credentials",
            status: "blocked",
            blocker: expect.objectContaining({ kind: "user_input_required" }),
          }),
        ]),
      });

      showCredentialLoginPage(harness.socket);
      harness.socket.snapshot.url = correctUrl;
      harness.resetProviderAttempt(correctUrl);
      const second = await harness.runtime.handle({
        text: "but that was the wrong portal; use the correct fictional portal instead",
        channel: "cli",
        trustedWorkspace: true,
        onSecureInputRequest: harness.secureInputHandler,
      });

      expect(second.text).toContain("Authentication confirmed from the authenticated account page.");
      expect(second.text).not.toContain("Mission needs your input");
      expect(second.toolExecutions.find((execution) => execution.tool.name === "browser.navigate")?.input).toMatchObject({
        url: correctUrl,
      });
      expect(latestExecutionPlanSnapshot(await harness.runtime.sessionDb.listEvents(harness.runtime.sessionId))).toMatchObject({
        status: "completed",
        items: expect.arrayContaining([
          expect.objectContaining({
            id: "execute",
            content: "Submit the required authentication credentials",
            status: "completed"
          }),
          expect.objectContaining({
            id: "verify",
            content: "Verify the authenticated state",
            status: "completed"
          }),
          expect.objectContaining({ id: "authentication.challenge", status: "completed" }),
        ]),
      });
      expect(harness.groupedCredentialPrompts).toBe(2);
      expect(harness.credentialSubmits).toBe(1);
      expect(harness.otpSubmits).toBe(1);
      expect(harness.providerRequests.length).toBeLessThanOrEqual(10);

      const persisted = {
        messages: await harness.runtime.sessionDb.listMessages(harness.runtime.sessionId),
        events: await harness.runtime.sessionDb.listEvents(harness.runtime.sessionId),
        providerRequests: harness.providerRequests,
        first,
        second,
      };
      const serialized = inspect(persisted, { depth: 20, maxArrayLength: null });
      for (const secret of SECRETS) expect(serialized).not.toContain(secret);
    } finally {
      await harness.runtime.dispose();
    }
  });

  it("captures the known efficiency gaps in recalled browser authentication", async () => {
    const harness = await createAcceptanceHarness({
      name: "recalled fictional portal",
      authenticated: true,
      expectedCredentialSubmits: 1,
      expectedOtpPrompts: 1,
      expectedOtpSubmits: 1,
    });
    const recalledUrl = `${PORTAL_ORIGIN}/current/login`;
    harness.resetProviderAttempt(recalledUrl);
    await seedHistoricalBrowserJourneys(harness.runtime, recalledUrl);
    expect(harness.socket.sent).toHaveLength(0);

    try {
      const response = await harness.runtime.handle({
        text: "Open the fictional developer portal we visited in previous sessions and log us in.",
        channel: "cli",
        trustedWorkspace: true,
        onSecureInputRequest: harness.secureInputHandler,
      });

      const recallRequests = harness.providerRequests.filter(isSessionRecallProviderRequest);
      const primaryRequests = harness.providerRequests.filter((request) => !isSessionRecallProviderRequest(request));
      const planOnlyRequests = primaryRequests.filter((request) => {
        const names = providerToolNames(request);
        return names.length === 1 && names[0] === "plan";
      });
      const firstActionRequest = primaryRequests.find((request) =>
        providerToolNames(request).some((name) => name.startsWith("browser_"))
      );
      const firstActionTools = firstActionRequest === undefined ? [] : providerToolNames(firstActionRequest);
      const initialPrimaryPrompt = primaryRequests[0] === undefined
        ? ""
        : renderProviderRequestText(primaryRequests[0]);
      const sessionEvents = await harness.runtime.sessionDb.listEvents(harness.runtime.sessionId);
      const intentEvent = sessionEvents.find((event) => event.kind === "intent-routed");
      const missionStartedIndex = sessionEvents.findIndex((event) => event.kind === "execution-plan-started");
      const navigationPlannedIndex = sessionEvents.findIndex((event) =>
        event.kind === "tool-plan" && event.plan.tool === "browser.navigate"
      );
      const violations = [
        ...(recallRequests.length === 0 ? [] : [`visited-site recall dispatched ${recallRequests.length} provider request(s)`]),
        ...(planOnlyRequests.length === 0 ? [] : [`Mission activation consumed ${planOnlyRequests.length} plan-only request(s)`]),
        ...(harness.primaryProviderRequestsAtCredentialPrompt <= 2
          ? []
          : [`protected input required ${harness.primaryProviderRequestsAtCredentialPrompt} primary provider request(s)`]),
        ...(initialPrimaryPrompt.includes(recalledUrl)
          ? []
          : ["the verified recalled destination was absent from the initial primary prompt"]),
        ...(firstActionTools.some((name) => name === "browser_navigate")
          ? []
          : ["the first actionable provider inventory did not expose browser navigation"]),
        ...(firstActionTools.some((name) => name.startsWith("terminal_") || name.startsWith("mcp_") || name.startsWith("file_"))
          ? ["the browser-authentication turn exposed unrelated tool systems"]
          : []),
      ];

      expect(intentEvent).toEqual({
        kind: "intent-routed",
        route: expect.objectContaining({
          nativeIntent: "browser-control",
          labels: expect.arrayContaining(["browser-control", "authentication"]),
          confidence: expect.any(Number),
          suggestedToolsets: ["browser"],
        }),
      });
      if (intentEvent?.kind === "intent-routed") {
        expect(intentEvent.route.confidence).toBeGreaterThanOrEqual(0.9);
      }
      expect(missionStartedIndex).toBeGreaterThanOrEqual(0);
      expect(navigationPlannedIndex).toBeGreaterThan(missionStartedIndex);
      expect(planOnlyRequests).toHaveLength(0);
      expect(primaryRequests[0] === undefined ? [] : providerToolNames(primaryRequests[0])).toContain("browser_navigate");
      expect(response.text).toContain("Authentication confirmed from the authenticated account page.");
      const journeyTools = response.toolExecutions.map((execution) => execution.tool.name);
      const navigationIndex = journeyTools.indexOf("browser.navigate");
      const credentialsIndex = journeyTools.indexOf("browser.fill_protected_form");
      const otpIndex = journeyTools.indexOf("browser.type");
      expect(navigationIndex).toBeGreaterThanOrEqual(0);
      expect(credentialsIndex).toBeGreaterThan(navigationIndex);
      expect(otpIndex).toBeGreaterThan(credentialsIndex);
      expect(harness.socket.sent.some((message) => message.method === "Page.navigate")).toBe(true);
      const persisted = {
        messages: await harness.runtime.sessionDb.listMessages(harness.runtime.sessionId),
        events: sessionEvents,
        providerRequests: harness.providerRequests,
        response,
      };
      const serialized = inspect(persisted, { depth: 20, maxArrayLength: null });
      for (const secret of SECRETS) expect(serialized).not.toContain(secret);
      // This is a temporary executable characterization of the production
      // regression. Each corrective commit removes its corresponding entry;
      // the final journey contract is an empty list.
      expect(violations).toEqual([]);
    } finally {
      await harness.runtime.dispose();
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
  let primaryProviderRequestsAtCredentialPrompt: number | undefined;

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
    complete: async (request) => providerScript.complete(request),
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
      if (
        scenario.cancelFirstCollectionOnly &&
        groupedCredentialPrompts === 1 &&
        context.group?.index === 1
      ) return { status: "cancelled" as const };
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
    primaryProviderRequestsAtCredentialPrompt ??= providerRequests.filter(
      (providerRequest) => !isSessionRecallProviderRequest(providerRequest),
    ).length;
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
    resetProviderAttempt: providerScript.resetAttempt,
    get groupedCredentialPrompts() { return groupedCredentialPrompts; },
    get otpPrompts() { return otpPrompts; },
    get credentialSubmits() { return credentialSubmits; },
    get otpSubmits() { return otpSubmits; },
    get primaryProviderRequestsAtCredentialPrompt() {
      return primaryProviderRequestsAtCredentialPrompt ?? Number.POSITIVE_INFINITY;
    },
  };
}

function createProviderScript(input: {
  socket: FakeCdpAuthPortalSocket;
  timeline: string[];
  providerRequests: ProviderRequest[];
}) {
  let planRequested = false;
  let navigateRequested = false;
  let credentialsRequested = false;
  let otpRequested = false;
  let authenticatedSnapshotRequested = false;
  let nextCallId = 1;
  let navigationUrl = `${PORTAL_ORIGIN}/login`;

  const complete = (request: ProviderRequest): ProviderResponse => {
    input.timeline.push("provider");
    input.providerRequests.push(structuredClone(request));
    if (isSessionRecallProviderRequest(request)) {
      return finalResponse(JSON.stringify({
        summary: "Source session history did not establish a verified destination URL.",
      }));
    }
    const call = (name: string, args: Record<string, unknown>) => toolCallResponse(
      `acceptance-call-${nextCallId++}`,
      name,
      args,
    );

    if (!planRequested && providerToolNames(request).length === 1 && providerToolNames(request)[0] === "plan") {
      planRequested = true;
      return call("plan", {
        operation: "write",
        objective: "Authenticate the fictional developer account and verify the resulting state.",
        items: [
          { id: "authentication.credentials", content: "Submit credentials", status: "in_progress" },
          { id: "authentication.verify", content: "Verify authentication", status: "pending" },
        ],
      });
    }
    if (!navigateRequested) {
      navigateRequested = true;
      return call("browser.navigate", { url: navigationUrl });
    }
    if (!credentialsRequested) {
      credentialsRequested = true;
      return call("browser.fill_protected_form", {
        purpose: "Sign in to the test portal",
        identity: latestIdentity(request),
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
        identity: latestIdentity(request),
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

  return {
    complete,
    resetAttempt(url = `${PORTAL_ORIGIN}/login`) {
      navigateRequested = false;
      credentialsRequested = false;
      otpRequested = false;
      authenticatedSnapshotRequested = false;
      navigationUrl = url;
    },
  };
}

function providerToolNames(request: ProviderRequest): string[] {
  if (!Array.isArray(request.tools)) return [];
  return request.tools.flatMap((tool) => {
    if (typeof tool !== "object" || tool === null) return [];
    const fn = (tool as { function?: { name?: unknown } }).function;
    return typeof fn?.name === "string" ? [fn.name] : [];
  });
}

function isSessionRecallProviderRequest(request: ProviderRequest): boolean {
  return renderProviderRequestText(request).includes(
    "Summarize historical EstaCoda session search context for manual recall.",
  );
}

function renderProviderRequestText(request: ProviderRequest): string {
  return request.messages.map((message) =>
    typeof message.content === "string" ? message.content : JSON.stringify(message.content)
  ).join("\n");
}

async function seedHistoricalBrowserJourneys(runtime: Runtime, recalledUrl: string): Promise<void> {
  const active = await runtime.sessionDb.getSession(runtime.sessionId);
  if (active === undefined) throw new Error("Acceptance runtime session was not created.");

  const destinations = [
    recalledUrl,
    `${PORTAL_ORIGIN}/legacy/login`,
    `${PORTAL_ORIGIN}/docs`,
  ];
  for (const [index, destination] of destinations.entries()) {
    const sessionId = `historical-browser-journey-${index + 1}`;
    const toolCallId = `historical-navigation-${index + 1}`;
    await runtime.sessionDb.createSession({
      id: sessionId,
      profileId: active.profileId,
      title: "Fictional developer portal",
      metadata: active.metadata,
    });
    await runtime.sessionDb.appendMessage({
      id: `${sessionId}-request`,
      sessionId,
      role: "user",
      content: "Open the fictional developer portal we use for browser authentication.",
    });
    await runtime.sessionDb.appendEvent(sessionId, {
      kind: "tool-called",
      tool: "browser.navigate",
      input: { url: destination },
      toolCallId,
    });
    await runtime.sessionDb.appendEvent(sessionId, {
      kind: "tool-result",
      tool: "browser.navigate",
      result: {
        ok: true,
        content: [
          "Browser: local-cdp",
          `URL: ${destination}`,
          "",
          "Action completed with an observable page change.",
          `URL: ${destination}`,
        ].join("\n"),
      },
      toolCallId,
    });
  }
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
  const identity = latest === undefined ? undefined : {
    documentEpoch: Number(latest[1]),
    actionRevision: Number(latest[2]),
    observationId: Number(latest[3]),
  };
  if (identity === undefined || Object.values(identity).some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error("The acceptance provider did not receive a current browser identity.");
  }
  return identity;
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
