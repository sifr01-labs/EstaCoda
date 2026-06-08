// WorkflowAgentLoopAdapter — adapter layer between WorkflowEngine and AgentLoop
// Workflow integration — steer consumption, run/artifact linkage, automatic event summaries

import type { AgentLoop, AgentLoopInput, AgentLoopResponse } from "../runtime/agent-loop.js";
import type { WorkflowRun, WorkflowRunId, WorkflowStep, RunId } from "./types.js";
import type { WorkflowStore } from "./workflow-store.js";
import type { WorkflowEventSummaryService } from "./workflow-event-summary-service.js";
import { normalizeWorkflowActivationReason } from "../contracts/workflow-context.js";

export type WorkflowAgentLoopAdapterOptions = {
  agentLoop: AgentLoop;
  store: WorkflowStore;
  compactionService?: WorkflowEventSummaryService;
};

export type WorkflowTurnInput = {
  run: WorkflowRun;
  step?: WorkflowStep;
  text: string;
  channel: AgentLoopInput["channel"];
  signal?: AbortSignal;
  onEvent?: AgentLoopInput["onEvent"];
};

export type WorkflowTurnResult = {
  response: AgentLoopResponse;
  runId: WorkflowRunId;
  stepId?: string;
  steerGuidance?: string[];
};

/**
 * Adapter that sits between WorkflowEngine and AgentLoop.
 *
 * Design (locked in ADR-0004):
 * - The workflow module is above AgentLoop; AgentLoop remains workflow-agnostic.
 * - The adapter passes an AbortSignal and records turn metadata.
 * - Steer guidance is loaded from unconsumed operator-steered events and passed
 *   explicitly as prefixed context. No hidden prompt mutation.
 * - Run and artifact linkage is recorded after each turn.
 * - Automatic compaction is checked at safe boundaries (between turns).
 */
export class WorkflowAgentLoopAdapter {
  readonly #agentLoop: AgentLoop;
  readonly #store: WorkflowStore;
  readonly #compactionService?: WorkflowEventSummaryService;

  constructor(options: WorkflowAgentLoopAdapterOptions) {
    this.#agentLoop = options.agentLoop;
    this.#store = options.store;
    this.#compactionService = options.compactionService;
  }

  /**
   * Execute a single turn within a flow.
   *
   * The adapter:
   * 1. Loads any unconsumed steer events for the flow.
   * 2. Prefixes steer guidance in a structured operator-guidance block (explicit, auditable).
   * 3. Calls AgentLoop.handle() with the provided signal for cancellation.
   * 4. Marks steer events as consumed, linking them to the step/trajectory.
   * 5. Records run links using the real trajectory ID from the AgentLoop.
   * 6. Records artifact links to the store.
   * 7. Checks automatic compaction at the safe boundary.
   */
  async runTurn(input: WorkflowTurnInput): Promise<WorkflowTurnResult> {
    const runId = input.run.id;
    const stepId = input.step?.id;

    // 1. Load unconsumed steer events
    const steerEvents = await this.#store.listUnconsumedSteerEvents(runId);
    const steerGuidance = steerEvents.map((ev) => ev.metadata?.guidance as string).filter((g): g is string => typeof g === "string");

    // 2. Build text with structured operator-guidance block
    let turnText = input.text;
    if (steerGuidance.length > 0) {
      const eventIds = steerEvents.map((ev) => ev.id).join(", ");
      const prefix = `--- OPERATOR GUIDANCE (eventIds: ${eventIds}) ---\n${steerGuidance.map((g, i) => `${i + 1}. ${g}`).join("\n")}\n--- END OPERATOR GUIDANCE ---\n\n`;
      turnText = prefix + turnText;
    }

    // 3. Execute turn
    const response = await this.#agentLoop.handle({
      text: turnText,
      channel: input.channel,
      signal: input.signal,
      onEvent: input.onEvent,
      workflow: {
        runId,
        ...(stepId === undefined ? {} : { stepId }),
        activationReason: normalizeWorkflowActivationReason(input.run.metadata.activationReason)
      }
    });

    // 4. Obtain real trajectory/run id from AgentLoop (never synthetic)
    const realRunId = this.#agentLoop.trajectoryId;

    // 5. Mark steer events as consumed with real linkage
    for (const ev of steerEvents) {
      await this.#store.markSteerConsumed(ev.id, {
        consumedByStepId: stepId,
        consumedByRunId: realRunId
      });
    }

    // 6. Record run linkage using real trajectory id
    if (stepId && realRunId) {
      const existingLinks = await this.#store.listWorkflowAgentRunLinks(runId, stepId);
      await this.#store.linkWorkflowAgentRun({
        agentRunId: realRunId,
        stepId,
        runId,
        turnIndex: existingLinks.length,
        linkedAt: new Date().toISOString()
      });
    } else if (stepId && !realRunId) {
      // Real id unavailable: record explicit flow_event explaining why
      await this.#store.appendWorkflowEvent({
        id: crypto.randomUUID(),
        runId,
        stepId,
        kind: "run-link-unavailable",
        timestamp: new Date().toISOString(),
        data: { reason: "AgentLoop did not expose a trajectoryId" }
      });
    }

    // 7. Record artifact linkage
    for (const artifact of response.artifacts) {
      if (stepId) {
        await this.#store.linkWorkflowArtifact({
          artifactId: artifact.id,
          stepId,
          runId,
          kind: "created",
          linkedAt: new Date().toISOString()
        });
      }
    }

    // 8. Check automatic compaction at safe boundary
    if (this.#compactionService) {
      await this.#compactionService.checkAndAutoCompact(runId);
    }

    return {
      response,
      runId: input.run.id,
      stepId: input.step?.id,
      steerGuidance: steerGuidance.length > 0 ? steerGuidance : undefined
    };
  }
}
