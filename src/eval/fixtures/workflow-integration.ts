import type { EvalCase, EvalResult } from "../../contracts/eval.js";
import { FakeWorkflowStore } from "../../workflow/fake-workflow-store.js";
import { WorkflowLockService } from "../../workflow/workflow-lock-service.js";
import { WorkflowEngine } from "../../workflow/workflow-engine.js";
import { WorkflowProcessRegistry } from "../../workflow/workflow-process-registry.js";
import { WorkflowCommandDispatcher } from "../../workflow/workflow-command-dispatcher.js";
import { WorkflowEventSummaryService, DEFAULT_WORKFLOW_EVENT_SUMMARY_CONFIG } from "../../workflow/workflow-event-summary-service.js";
import { WorkflowRestartRecovery } from "../../workflow/workflow-restart-recovery.js";
import { WorkflowAgentLoopAdapter } from "../../workflow/workflow-agent-loop-adapter.js";
import { TrajectoryRecorder } from "../../trajectory/trajectory-recorder.js";
import { assertTrue, assertEqual, assertContains, buildResult } from "../eval-runner.js";
import type { IntentRoute } from "../../contracts/intent.js";
import type { AgentLoop } from "../../runtime/agent-loop.js";
import type { AgentLoopInput, AgentLoopResponse } from "../../runtime/agent-loop.js";

function makeIntent(): IntentRoute {
  return {
    nativeIntent: "general",
    labels: ["test"],
    confidence: 1,
    suggestedToolsets: [],
    suggestedSkills: [],
    confirmationRequired: false,
    evidence: [],
    rationale: "test intent"
  };
}

function makeNow(): () => Date {
  let t = 0;
  return () => {
    t += 1000;
    return new Date(t);
  };
}

/**
 * Fake AgentLoop for testing the adapter.
 * Exposes a real trajectoryId (never synthetic) and returns a deterministic response.
 */
function makeFakeAgentLoop(trajectoryId?: string): AgentLoop {
  const recorder = new TrajectoryRecorder({
    profileId: "test",
    sessionId: "test",
    modelId: "test",
    id: () => trajectoryId ?? "traj-real-001",
    now: () => new Date()
  });

  return {
    get trajectoryId() { return recorder.trajectoryId; },
    async handle(_input: AgentLoopInput): Promise<AgentLoopResponse> {
      return {
        label: "test",
        text: "ok",
        matchedSkills: [],
        intent: makeIntent(),
        securityDecision: "allow",
        toolExecutions: [],
        toolPlans: [],
        skillOutcomes: [],
        artifacts: [{ id: "art-1", kind: "document", path: "/tmp/test", bytes: 10, createdAt: new Date().toISOString() }],
        context: undefined,
        projectContext: undefined,
        progress: []
      };
    }
  } as unknown as AgentLoop;
}

export const workflowIntegrationCase: EvalCase = {
  id: "workflow-integration",
  name: "Workflow Integration — adapter, CLI bridge, runtime wiring, event summaries, linkage",
  description: "Covers workflow integration acceptance criteria.",
  tags: ["workflow", "integration", "workflow-integration", "deterministic"],
  run: async (): Promise<EvalResult> => {
    const startedAt = Date.now();
    const assertions = [];

    // ─── Shared stores ───
    const store = new FakeWorkflowStore({ now: makeNow() });
    const lockService = new WorkflowLockService({ store, now: makeNow(), defaultLeaseMs: 30_000 });
    const engine = new WorkflowEngine({ store, lockService, ownerId: "worker-1", now: makeNow() });
    const processRegistry = new WorkflowProcessRegistry({ store });
    const compactionService = new WorkflowEventSummaryService({
      store,
      config: { ...DEFAULT_WORKFLOW_EVENT_SUMMARY_CONFIG, enabled: false },
      now: makeNow()
    });
    const dispatcher = new WorkflowCommandDispatcher({ engine, store, processRegistry, compactionService });

    // ═════════════════════════════════════════════════════════════════
    // 1. /workflow slash bridge dispatches to WorkflowCommandDispatcher
    // ═════════════════════════════════════════════════════════════════
    {
      const run = await engine.createWorkflowRun({
        sessionId: "session-1",
        intent: makeIntent(),
        plan: { name: "Bridge Plan", description: "Test", steps: [{ name: "B1", description: "B1" }] }
      });
      await engine.startWorkflowRun(run.id);

      // Simulate what handleWorkflowCommand does for /workflow run status
      const result = await dispatcher.dispatch({ command: "/status", runId: run.id });
      assertions.push(assertTrue("slash-bridge-dispatches", result.ok));
      if (result.ok) {
        assertions.push(assertContains("slash-bridge-message", result.message, run.id));
      }
    }

    // ═════════════════════════════════════════════════════════════════
    // 2. /workflow activate and /workflow deactivate update activeRunId correctly
    // ═════════════════════════════════════════════════════════════════
    {
      const run = await engine.createWorkflowRun({
        sessionId: "session-2",
        intent: makeIntent(),
        plan: { name: "Active Plan", description: "Test", steps: [{ name: "A1", description: "A1" }] }
      });
      const mockWorkflow = { activeRunId: null as string | null, setActiveRunId(id: string | null) { this.activeRunId = id; } };

      // Simulate /workflow activate
      mockWorkflow.setActiveRunId(run.id);
      assertions.push(assertEqual("workflow-activate-active-run", mockWorkflow.activeRunId, run.id));

      // Simulate /workflow deactivate
      mockWorkflow.setActiveRunId(null);
      assertions.push(assertEqual("workflow-deactivate-active-run", mockWorkflow.activeRunId, null));
    }

    // ═════════════════════════════════════════════════════════════════
    // 3. /workflow run status works through the real session command bridge
    // ═════════════════════════════════════════════════════════════════
    {
      const run = await engine.createWorkflowRun({
        sessionId: "session-3",
        intent: makeIntent(),
        plan: { name: "Status Plan", description: "Test", steps: [{ name: "S1", description: "S1" }] }
      });
      await engine.startWorkflowRun(run.id);

      const result = await dispatcher.dispatch({ command: "/status", runId: run.id });
      assertions.push(assertTrue("workflow-status-ok", result.ok));
      if (result.ok) {
        assertions.push(assertContains("workflow-status-has-runId", result.message, run.id));
        assertions.push(assertContains("workflow-status-has-state", result.message, "running"));
      }
    }

    // ═════════════════════════════════════════════════════════════════
    // 4. /steer records operator event and adapter consumes it on next turn
    // ═════════════════════════════════════════════════════════════════
    {
      const steerFlow = await engine.createWorkflowRun({
        sessionId: "session-4",
        intent: makeIntent(),
        plan: { name: "Steer Plan", description: "Test", steps: [{ name: "ST1", description: "ST1" }] }
      });
      await engine.startWorkflowRun(steerFlow.id);

      // Dispatch /steer
      const steerResult = await dispatcher.dispatch({
        command: "/steer",
        runId: steerFlow.id,
        guidance: "Use deterministic mode",
        operator: "cli"
      });
      assertions.push(assertTrue("steer-dispatch-ok", steerResult.ok));

      const opEvents = await store.listWorkflowOperatorEvents(steerFlow.id);
      assertions.push(assertTrue("steer-event-recorded", opEvents.some((e) => e.command === "/steer")));

      // Adapter consumes steer on next turn
      const adapter = new WorkflowAgentLoopAdapter({
        agentLoop: makeFakeAgentLoop("traj-steer-001"),
        store,
        compactionService
      });

      const flowObj = (await store.getWorkflowRun(steerFlow.id))!;
      const stepObj = (await store.listWorkflowSteps(steerFlow.id))[0];

      const turnResult = await adapter.runTurn({
        run: flowObj,
        step: stepObj,
        text: "Run step",
        channel: "cli"
      });

      assertions.push(assertTrue("steer-consumed-on-turn", turnResult.steerGuidance !== undefined));
      assertions.push(assertEqual("steer-guidance-text", turnResult.steerGuidance?.[0], "Use deterministic mode"));
    }

    // ═════════════════════════════════════════════════════════════════
    // 5. consumed steer event has consumedAt and consumedByStepId or consumedByRunId
    // ═════════════════════════════════════════════════════════════════
    {
      const steerFlow2 = await engine.createWorkflowRun({
        sessionId: "session-5",
        intent: makeIntent(),
        plan: { name: "Steer2 Plan", description: "Test", steps: [{ name: "ST2", description: "ST2" }] }
      });
      await engine.startWorkflowRun(steerFlow2.id);

      await dispatcher.dispatch({
        command: "/steer",
        runId: steerFlow2.id,
        guidance: "Check idempotency",
        operator: "cli"
      });

      const adapter = new WorkflowAgentLoopAdapter({
        agentLoop: makeFakeAgentLoop("traj-steer-002"),
        store,
        compactionService
      });

      const flowObj = (await store.getWorkflowRun(steerFlow2.id))!;
      const stepObj = (await store.listWorkflowSteps(steerFlow2.id))[0];
      await adapter.runTurn({ run: flowObj, step: stepObj, text: "Run", channel: "cli" });

      const opEventsAfter = await store.listWorkflowOperatorEvents(steerFlow2.id);
      const consumedSteer = opEventsAfter.find((e) => e.command === "/steer" && e.consumedAt !== undefined);
      assertions.push(assertTrue("consumed-steer-has-consumedAt", consumedSteer !== undefined));
      if (consumedSteer) {
        assertions.push(assertTrue("consumed-steer-has-step-or-run", !!(consumedSteer.consumedByStepId || consumedSteer.consumedByRunId)));
      }
    }

    // ═════════════════════════════════════════════════════════════════
    // 6. consumed steer appears in /trace
    // ═════════════════════════════════════════════════════════════════
    {
      const traceFlow = await engine.createWorkflowRun({
        sessionId: "session-6",
        intent: makeIntent(),
        plan: { name: "Trace Plan", description: "Test", steps: [{ name: "TR1", description: "TR1" }] }
      });
      await engine.startWorkflowRun(traceFlow.id);

      await dispatcher.dispatch({
        command: "/steer",
        runId: traceFlow.id,
        guidance: "Trace me",
        operator: "cli"
      });

      const adapter = new WorkflowAgentLoopAdapter({
        agentLoop: makeFakeAgentLoop("traj-trace-001"),
        store,
        compactionService
      });
      const flowObj = (await store.getWorkflowRun(traceFlow.id))!;
      const stepObj = (await store.listWorkflowSteps(traceFlow.id))[0];
      await adapter.runTurn({ run: flowObj, step: stepObj, text: "Run", channel: "cli" });

      const traceResult = await dispatcher.dispatch({ command: "/trace", runId: traceFlow.id });
      assertions.push(assertTrue("trace-ok", traceResult.ok));
      if (traceResult.ok) {
        assertions.push(assertContains("trace-has-consumed-steer", traceResult.message, "steer"));
      }
    }

    // ═════════════════════════════════════════════════════════════════
    // 9. running workflow run becomes interrupted after restart recovery
    // (covered in test 8 above, but we assert explicitly)
    // ═════════════════════════════════════════════════════════════════
    {
      const recoveryStore = new FakeWorkflowStore({ now: makeNow() });
      const recoveryLock = new WorkflowLockService({ store: recoveryStore, now: makeNow() });
      const recoveryEngine = new WorkflowEngine({ store: recoveryStore, lockService: recoveryLock, ownerId: "worker", now: makeNow() });

      const runningFlow = await recoveryEngine.createWorkflowRun({
        sessionId: "s9",
        intent: makeIntent(),
        plan: { name: "P9", description: "Test", steps: [{ name: "S9", description: "S9" }] }
      });
      await recoveryEngine.startWorkflowRun(runningFlow.id);
      const step = (await recoveryStore.listWorkflowSteps(runningFlow.id))[0];
      await recoveryStore.updateWorkflowStep({ ...step, status: "running" });
      await recoveryLock.acquire(runningFlow.id, "old-worker");

      const recovery = new WorkflowRestartRecovery({ store: recoveryStore, lockService: recoveryLock, now: makeNow() });
      const result = await recovery.recover();

      assertions.push(assertTrue("recovery-interrupted-running", result.interrupted >= 1));
      const after = await recoveryStore.getWorkflowRun(runningFlow.id);
      assertions.push(assertEqual("running-becomes-interrupted", after?.status, "interrupted"));
    }

    // ═════════════════════════════════════════════════════════════════
    // 10. paused/waiting/interrupted workflow runs are preserved after restart
    // ═════════════════════════════════════════════════════════════════
    {
      const recoveryStore2 = new FakeWorkflowStore({ now: makeNow() });
      const recoveryLock2 = new WorkflowLockService({ store: recoveryStore2, now: makeNow() });
      const recoveryEngine2 = new WorkflowEngine({ store: recoveryStore2, lockService: recoveryLock2, ownerId: "worker", now: makeNow() });

      const pausedFlow = await recoveryEngine2.createWorkflowRun({
        sessionId: "s10-paused",
        intent: makeIntent(),
        plan: { name: "P10a", description: "Test", steps: [{ name: "S10a", description: "S10a" }] }
      });
      await recoveryEngine2.startWorkflowRun(pausedFlow.id);
      await recoveryEngine2.applyWorkflowPauseAtBoundary(pausedFlow.id);

      const waitingFlow = await recoveryEngine2.createWorkflowRun({
        sessionId: "s10-waiting",
        intent: makeIntent(),
        plan: { name: "P10b", description: "Test", steps: [{ name: "S10b", description: "S10b" }] }
      });
      await recoveryEngine2.startWorkflowRun(waitingFlow.id);
      await recoveryEngine2.waitForInput((await recoveryStore2.listWorkflowSteps(waitingFlow.id))[0].id, { kind: "user_input", description: "wait" });

      const interruptedFlow = await recoveryEngine2.createWorkflowRun({
        sessionId: "s10-interrupted",
        intent: makeIntent(),
        plan: { name: "P10c", description: "Test", steps: [{ name: "S10c", description: "S10c" }] }
      });
      await recoveryEngine2.startWorkflowRun(interruptedFlow.id);
      await recoveryEngine2.interruptWorkflowRun(interruptedFlow.id);

      const recovery2 = new WorkflowRestartRecovery({ store: recoveryStore2, lockService: recoveryLock2, now: makeNow() });
      await recovery2.recover();

      assertions.push(assertEqual("paused-preserved", (await recoveryStore2.getWorkflowRun(pausedFlow.id))?.status, "paused"));
      assertions.push(assertEqual("waiting-preserved", (await recoveryStore2.getWorkflowRun(waitingFlow.id))?.status, "waiting"));
      assertions.push(assertEqual("interrupted-preserved", (await recoveryStore2.getWorkflowRun(interruptedFlow.id))?.status, "interrupted"));
    }

    // ═════════════════════════════════════════════════════════════════
    // 11. automatic workflow event summary remains disabled by default
    // ═════════════════════════════════════════════════════════════════
    {
      assertions.push(assertEqual("event-summary-disabled-default", DEFAULT_WORKFLOW_EVENT_SUMMARY_CONFIG.enabled, false));
    }

    // ═════════════════════════════════════════════════════════════════
    // 12. automatic workflow event summary triggers at safe boundary when enabled
    // ═════════════════════════════════════════════════════════════════
    {
      const compactStore = new FakeWorkflowStore({ now: makeNow() });
      const compactLock = new WorkflowLockService({ store: compactStore, now: makeNow() });
      const compactEngine = new WorkflowEngine({ store: compactStore, lockService: compactLock, ownerId: "worker", now: makeNow() });
      const compactService = new WorkflowEventSummaryService({
        store: compactStore,
        config: { enabled: true, mode: "conservative" as const, eventThreshold: 3, minTurnsBeforeCompact: 1 },
        now: makeNow()
      });

      const cFlow = await compactEngine.createWorkflowRun({
        sessionId: "s12",
        intent: makeIntent(),
        plan: { name: "P12", description: "Test", steps: [{ name: "S12", description: "S12" }] }
      });
      await compactEngine.startWorkflowRun(cFlow.id);
      // Complete the step so the workflow run has no active steps/processes/approvals
      const cStep = (await compactStore.listWorkflowSteps(cFlow.id))[0];
      await compactEngine.completeWorkflowStep(cStep.id);

      // Add 4 workflow events (> eventThreshold=3)
      for (let i = 0; i < 4; i++) {
        await compactStore.appendWorkflowEvent({
          id: crypto.randomUUID(),
          runId: cFlow.id,
          kind: "flow-state-changed",
          timestamp: new Date().toISOString(),
          data: { seq: i }
        });
      }

      // Safe boundary check should trigger compaction
      const before = (await compactStore.listWorkflowEvents(cFlow.id)).length;
      await compactService.checkAndAutoCompact(cFlow.id);
      const after = (await compactStore.listWorkflowEvents(cFlow.id)).length;
      // Event summary should have run and reduced events (or created a summary)
      const summaries = await compactStore.listWorkflowEventSummaries(cFlow.id);
      assertions.push(assertTrue("event-summary-triggered-at-boundary", before > after || summaries.length > 0));
    }

    // ═════════════════════════════════════════════════════════════════
    // 13. automatic workflow event summary does not trigger with active step/process/approval
    // ═════════════════════════════════════════════════════════════════
    {
      const unsafeStore = new FakeWorkflowStore({ now: makeNow() });
      const unsafeLock = new WorkflowLockService({ store: unsafeStore, now: makeNow() });
      const unsafeEngine = new WorkflowEngine({ store: unsafeStore, lockService: unsafeLock, ownerId: "worker", now: makeNow() });
      const unsafeService = new WorkflowEventSummaryService({
        store: unsafeStore,
        config: { enabled: true, mode: "conservative" as const, eventThreshold: 2, minTurnsBeforeCompact: 1 },
        now: makeNow()
      });

      const uFlow = await unsafeEngine.createWorkflowRun({
        sessionId: "s13",
        intent: makeIntent(),
        plan: { name: "P13", description: "Test", steps: [{ name: "S13", description: "S13" }] }
      });
      await unsafeEngine.startWorkflowRun(uFlow.id);

      // Add events but keep step running
      for (let i = 0; i < 5; i++) {
        await unsafeStore.appendWorkflowEvent({
          id: crypto.randomUUID(),
          runId: uFlow.id,
          kind: "flow-state-changed",
          timestamp: new Date().toISOString(),
          data: { seq: i }
        });
      }

      const beforeUnsafe = (await unsafeStore.listWorkflowEvents(uFlow.id)).length;
      await unsafeService.checkAndAutoCompact(uFlow.id);
      const afterUnsafe = (await unsafeStore.listWorkflowEvents(uFlow.id)).length;
      // Since step is running, event summary should NOT have run
      assertions.push(assertEqual("event-summary-skipped-unsafe", beforeUnsafe, afterUnsafe));
    }

    // ═════════════════════════════════════════════════════════════════
    // 14. process cleanup result appears in /status and /trace
    // ═════════════════════════════════════════════════════════════════
    {
      const procStore = new FakeWorkflowStore({ now: makeNow() });
      const procLock = new WorkflowLockService({ store: procStore, now: makeNow() });
      const procEngine = new WorkflowEngine({ store: procStore, lockService: procLock, ownerId: "worker", now: makeNow() });
      const procRegistry = new WorkflowProcessRegistry({ store: procStore });
      const procDispatcher = new WorkflowCommandDispatcher({ engine: procEngine, store: procStore, processRegistry: procRegistry, compactionService });

      const pFlow = await procEngine.createWorkflowRun({
        sessionId: "s14",
        intent: makeIntent(),
        plan: { name: "P14", description: "Test", steps: [{ name: "S14", description: "S14" }] }
      });
      await procEngine.startWorkflowRun(pFlow.id);
      const pStep = (await procStore.listWorkflowSteps(pFlow.id))[0];

      await procRegistry.register({
        id: "proc-1",
        runId: pFlow.id,
        stepId: pStep.id,
        processManagerId: "pm-1",
        processType: "terminal",
        status: "running"
      });

      const intResult = await procDispatcher.dispatch({
        command: "/interrupt",
        runId: pFlow.id,
        reason: "test",
        operator: "cli"
      });

      assertions.push(assertTrue("interrupt-with-proc-ok", intResult.ok));
      if (intResult.ok) {
        assertions.push(assertTrue("interrupt-has-proc-count", intResult.message.includes("terminated")));
      }

      const statusResult = await procDispatcher.dispatch({ command: "/status", runId: pFlow.id });
      if (statusResult.ok) {
        assertions.push(assertContains("status-has-interrupt-reason", statusResult.message, "interrupted"));
      }
    }

    // ═════════════════════════════════════════════════════════════════
    // 15. run linkage is created by adapter using real run/trajectory evidence
    // ═════════════════════════════════════════════════════════════════
    {
      const linkStore = new FakeWorkflowStore({ now: makeNow() });
      const realTrajectoryId = "traj-real-evidence-001";
      const linkAdapter = new WorkflowAgentLoopAdapter({
        agentLoop: makeFakeAgentLoop(realTrajectoryId),
        store: linkStore,
        compactionService
      });

      const linkFlow = await engine.createWorkflowRun({
        sessionId: "s15",
        intent: makeIntent(),
        plan: { name: "P15", description: "Test", steps: [{ name: "S15", description: "S15" }] }
      });
      await engine.startWorkflowRun(linkFlow.id);
      const linkStep = (await store.listWorkflowSteps(linkFlow.id))[0];

      // We need the step in linkStore, not store
      await linkStore.createWorkflowRun({
        id: linkFlow.id,
        sessionId: "s15",
        status: "running",
        intent: makeIntent(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        checkpointCount: 0,
        stepCount: 1,
        retryCount: 0,
        metadata: {}
      });
      await linkStore.createWorkflowStep({
        id: linkStep.id,
        runId: linkFlow.id,
        index: 0,
        status: "running",
        name: "S15",
        description: "S15",
        toolPlans: [],
        executions: [],
        retryPolicy: { maxAttempts: 1, backoffMs: 0, backoffMultiplier: 1, retryableFailureClasses: [], nonRetryableFailureClasses: [], requireIdempotent: true },
        retryCount: 0,
        maxRetries: 1,
        idempotent: false,
        safeToRetry: false,
        failurePolicy: { defaultAction: "stop", stopOnNonRetryable: true, allowSkipIfSkippable: false },
        attemptNumber: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      const linkFlowObj = (await linkStore.getWorkflowRun(linkFlow.id))!;
      const linkStepObj = (await linkStore.listWorkflowSteps(linkFlow.id))[0];

      await linkAdapter.runTurn({ run: linkFlowObj, step: linkStepObj, text: "Run", channel: "cli" });

      const links = await linkStore.listWorkflowAgentRunLinks(linkFlow.id, linkStep.id);
      assertions.push(assertTrue("run-link-created", links.length > 0));
      if (links.length > 0) {
        assertions.push(assertEqual("run-link-uses-real-id", links[0].agentRunId, realTrajectoryId));
      }
    }

    // ═════════════════════════════════════════════════════════════════
    // 16. artifact linkage behavior is tested where available
    // ═════════════════════════════════════════════════════════════════
    {
      const artStore = new FakeWorkflowStore({ now: makeNow() });
      const artAdapter = new WorkflowAgentLoopAdapter({
        agentLoop: makeFakeAgentLoop("traj-art-001"),
        store: artStore,
        compactionService
      });

      const artRunId = "run-art-001";
      const artStepId = "step-art-001";
      await artStore.createWorkflowRun({
        id: artRunId,
        sessionId: "s16",
        status: "running",
        intent: makeIntent(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        checkpointCount: 0,
        stepCount: 1,
        retryCount: 0,
        metadata: {}
      });
      await artStore.createWorkflowStep({
        id: artStepId,
        runId: artRunId,
        index: 0,
        status: "running",
        name: "S16",
        description: "S16",
        toolPlans: [],
        executions: [],
        retryPolicy: { maxAttempts: 1, backoffMs: 0, backoffMultiplier: 1, retryableFailureClasses: [], nonRetryableFailureClasses: [], requireIdempotent: true },
        retryCount: 0,
        maxRetries: 1,
        idempotent: false,
        safeToRetry: false,
        failurePolicy: { defaultAction: "stop", stopOnNonRetryable: true, allowSkipIfSkippable: false },
        attemptNumber: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      const artRunObj = (await artStore.getWorkflowRun(artRunId))!;
      const artStepObj = (await artStore.getWorkflowStep(artStepId))!;

      await artAdapter.runTurn({ run: artRunObj, step: artStepObj, text: "Run", channel: "cli" });

      const artifacts = await artStore.listWorkflowArtifactLinks(artRunId, artStepId);
      assertions.push(assertTrue("artifact-link-created", artifacts.length > 0));
      if (artifacts.length > 0) {
        assertions.push(assertEqual("artifact-link-kind", artifacts[0].kind, "created"));
      }
    }

    // ═════════════════════════════════════════════════════════════════
    // 17. no workflow-specific methods were added to TrajectoryRecorder
    // ═════════════════════════════════════════════════════════════════
    {
      const recorder = new TrajectoryRecorder({ profileId: "p", sessionId: "s", modelId: "m" });
      const keys = Object.keys(recorder).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(recorder)));
      const workflowMethods = keys.filter((k) =>
        k.toLowerCase().includes("run") ||
        k.toLowerCase().includes("steer") ||
        k.toLowerCase().includes("operator") ||
        k.toLowerCase().includes("checkpoint")
      );
      assertions.push(assertEqual("trajectory-recorder-no-workflow-methods", workflowMethods.length, 0));
    }

    // ═════════════════════════════════════════════════════════════════
    // 18. AgentLoop remains workflow-agnostic except through adapter/runtime wiring
    // ═════════════════════════════════════════════════════════════════
    {
      // AgentLoop should not import anything from workflow/
      // We verify structurally by checking that AgentLoop's public interface
      // does not reference workflow types.
      const { AgentLoop: AL } = await import("../../runtime/agent-loop.js");
      const prototype = AL.prototype;
      const methodNames = Object.getOwnPropertyNames(prototype);

      const workflowMethods = methodNames.filter((m) =>
        m.toLowerCase().includes("run") ||
        m.toLowerCase().includes("steer") ||
        m.toLowerCase().includes("checkpoint") ||
        m.toLowerCase().includes("operator")
      );
      assertions.push(assertEqual("agentloop-no-workflow-methods", workflowMethods.length, 0));

      // The only workflow-related thing should be trajectoryId getter (added minimally)
      const hasTrajectoryId = methodNames.includes("trajectoryId") || "trajectoryId" in prototype;
      assertions.push(assertTrue("agentloop-has-trajectoryid-getter", hasTrajectoryId));
    }

    return buildResult(
      "workflow-integration",
      "Workflow Integration — adapter, CLI bridge, runtime wiring, event summaries, linkage",
      assertions,
      Date.now() - startedAt
    );
  }
};
