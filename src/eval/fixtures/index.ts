import { providerTextResponseCase } from "./provider-text-response.js";
import { toolSecurityBlockCase } from "./tool-security-block.js";
import { missingToolFailureCase } from "./missing-tool-failure.js";
import { memoryPromotionProvenanceCase } from "./memory-promotion-provenance.js";
import { memoryDeactivateSuppressesCase } from "./memory-deactivate-suppresses.js";
import { memorySelectiveRendersCase } from "./memory-selective-renders.js";
import { memorySafetyFilesProtectedCase } from "./memory-safety-files-protected.js";
import { knowledgeForwardDepsCase } from "./knowledge-forward-deps.js";
import { knowledgeReverseDepsCase } from "./knowledge-reverse-deps.js";
import { knowledgeAffectedFilesCase } from "./knowledge-affected-files.js";
import { knowledgeGraphSummaryCase } from "./knowledge-graph-summary.js";
import { knowledgeCacheInvalidatesCase } from "./knowledge-cache-invalidates.js";
import { manifestCreationFromObservationCase } from "./manifest-creation-from-observation.js";
import { skillProposalManifestBridgeCase } from "./skill-proposal-manifest-bridge.js";
import { userCorrectionRecordingCase } from "./user-correction-recording.js";
import { toolDescriptionProposalCase } from "./tool-description-proposal.js";
import { routingMetadataProposalCase } from "./routing-metadata-proposal.js";
import { routingEvolutionBaselineCase } from "./routing-evolution-baseline.js";
import { evolutionExportShapeCase } from "./evolution-export-shape.js";
import { workflowRunStateTransitionsCase } from "./workflow-run-state-transitions.js";
import { workflowLockingCase } from "./workflow-locking.js";
import { workflowEngineLifecycleCase } from "./workflow-engine-lifecycle.js";
import { workflowRestartRecoveryCase } from "./workflow-restart-recovery.js";
import { workflowCommandControlCase } from "./workflow-command-control.js";
import { workflowEventSummaryCase } from "./workflow-event-summary.js";
import { workflowIntegrationCase } from "./workflow-integration.js";

export const defaultEvalFixtures = [
  providerTextResponseCase,
  toolSecurityBlockCase,
  missingToolFailureCase,
  memoryPromotionProvenanceCase,
  memoryDeactivateSuppressesCase,
  memorySelectiveRendersCase,
  memorySafetyFilesProtectedCase,
  knowledgeForwardDepsCase,
  knowledgeReverseDepsCase,
  knowledgeAffectedFilesCase,
  knowledgeGraphSummaryCase,
  knowledgeCacheInvalidatesCase,
  manifestCreationFromObservationCase,
  skillProposalManifestBridgeCase,
  userCorrectionRecordingCase,
  toolDescriptionProposalCase,
  routingMetadataProposalCase,
  routingEvolutionBaselineCase,
  evolutionExportShapeCase,
  workflowRunStateTransitionsCase,
  workflowLockingCase,
  workflowEngineLifecycleCase,
  workflowRestartRecoveryCase,
  workflowCommandControlCase,
  workflowEventSummaryCase,
  workflowIntegrationCase
];
