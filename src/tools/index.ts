import type { ToolProvider } from "../contracts/tool.js";
import { configToolProvider } from "../config/config-tools.js";
import { cronToolProvider } from "../cron/cron-tools.js";
import { delegationToolProvider } from "../delegation/delegation-tools.js";
import { knowledgeCodeToolProvider } from "../knowledge/knowledge-code-tools.js";
import { knowledgeMemoryToolProvider } from "../memory/knowledge-memory-tools.js";
import { memoryFileCompactionToolProvider } from "../memory/memory-file-compaction-tools.js";
import { memoryToolProvider } from "../memory/memory-tool.js";
import { processToolProvider } from "../process/process-tools.js";
import { workspaceTrustToolProvider } from "../security/workspace-trust-tools.js";
import { skillToolProvider } from "../skills/skill-tools.js";
import { builtinToolProvider } from "./builtin-tools.js";
import { executeCodeToolProvider } from "./execute-code-tool.js";
import { imageGenerationToolProvider } from "./image-generation-tools.js";
import { mediaToolProvider } from "./media-tools.js";
import { pythonToolProvider } from "./python-tools.js";
import { visionToolProvider } from "./vision-tools.js";
import { voiceToolProvider } from "./voice-tools.js";
import { webToolProvider } from "./web-tools.js";
import { workspaceToolProvider } from "./workspace-tools.js";

export {
  builtinToolProvider,
  configToolProvider,
  cronToolProvider,
  delegationToolProvider,
  executeCodeToolProvider,
  imageGenerationToolProvider,
  knowledgeCodeToolProvider,
  knowledgeMemoryToolProvider,
  mediaToolProvider,
  memoryFileCompactionToolProvider,
  memoryToolProvider,
  processToolProvider,
  pythonToolProvider,
  skillToolProvider,
  visionToolProvider,
  voiceToolProvider,
  webToolProvider,
  workspaceToolProvider,
  workspaceTrustToolProvider
};

export type ToolRegistrationPhase =
  | "pre-skill-visibility"
  | "post-skill-visibility"
  | "post-memory-provider"
  | "post-tool-executor";

export type ToolRegistrationEntry = {
  readonly provider: ToolProvider;
  readonly phase: ToolRegistrationPhase;
  readonly note?: string;
};

export const toolRegistrationPlan: readonly ToolRegistrationEntry[] = [
  { provider: builtinToolProvider, phase: "pre-skill-visibility" },
  { provider: pythonToolProvider, phase: "pre-skill-visibility" },
  { provider: webToolProvider, phase: "pre-skill-visibility" },
  { provider: workspaceToolProvider, phase: "pre-skill-visibility" },
  { provider: mediaToolProvider, phase: "pre-skill-visibility" },
  { provider: voiceToolProvider, phase: "pre-skill-visibility" },
  { provider: imageGenerationToolProvider, phase: "pre-skill-visibility" },
  { provider: visionToolProvider, phase: "pre-skill-visibility" },
  { provider: processToolProvider, phase: "pre-skill-visibility" },
  { provider: workspaceTrustToolProvider, phase: "pre-skill-visibility" },
  { provider: configToolProvider, phase: "pre-skill-visibility" },
  { provider: cronToolProvider, phase: "pre-skill-visibility" },
  { provider: memoryToolProvider, phase: "pre-skill-visibility" },
  { provider: memoryFileCompactionToolProvider, phase: "pre-skill-visibility" },
  { provider: skillToolProvider, phase: "post-skill-visibility" },
  { provider: knowledgeMemoryToolProvider, phase: "post-memory-provider" },
  {
    provider: knowledgeCodeToolProvider,
    phase: "post-memory-provider",
    note: "Preserves current registration order; this provider only needs workspaceRoot."
  },
  { provider: delegationToolProvider, phase: "post-tool-executor" },
  { provider: executeCodeToolProvider, phase: "post-tool-executor" }
];
