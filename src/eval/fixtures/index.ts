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
  userCorrectionRecordingCase
];
