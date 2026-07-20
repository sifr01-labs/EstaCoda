import type { ToolProvider } from "../contracts/tool.js";
import { builtinToolProvider } from "./builtin-tools.js";
import { configToolProvider } from "./config-tools.js";
import { cronToolProvider } from "./cron-tools.js";
import { delegationToolProvider } from "./delegation-tools.js";
import { executeCodeToolProvider } from "./execute-code-tool.js";
import { globToolProvider } from "./glob-tools.js";
import { grepToolProvider } from "./grep-tools.js";
import { imageGenerationToolProvider } from "./image-generation-tools.js";
import { knowledgeCodeToolProvider } from "./knowledge-code-tools.js";
import { knowledgeMemoryToolProvider } from "./knowledge-memory-tools.js";
import { mediaToolProvider } from "./media-tools.js";
import { memoryFileCompactionToolProvider } from "./memory-file-compaction-tools.js";
import { memoryRetrievalToolProvider } from "./memory-retrieval-tools.js";
import { memoryToolProvider } from "./memory-tool.js";
import { notebookToolProvider } from "./notebook-tools.js";
import { processToolProvider } from "./process-tools.js";
import { pythonToolProvider } from "./python-tools.js";
import { sessionSearchToolProvider } from "./session-search-tool.js";
import { skillToolProvider } from "./skill-tools.js";
import { taskResultToolProvider } from "./task-result-tools.js";
import { taskToolProvider } from "./task-tools.js";
import { visionToolProvider } from "./vision-tools.js";
import { voiceToolProvider } from "./voice-tools.js";
import { webToolProvider } from "./web-tools.js";
import { workspaceTrustToolProvider } from "./workspace-trust-tools.js";
import { workspaceToolProvider } from "./workspace-tools.js";

export {
  builtinToolProvider,
  configToolProvider,
  cronToolProvider,
  delegationToolProvider,
  executeCodeToolProvider,
  globToolProvider,
  grepToolProvider,
  imageGenerationToolProvider,
  knowledgeCodeToolProvider,
  knowledgeMemoryToolProvider,
  mediaToolProvider,
  memoryFileCompactionToolProvider,
  memoryRetrievalToolProvider,
  memoryToolProvider,
  notebookToolProvider,
  processToolProvider,
  pythonToolProvider,
  sessionSearchToolProvider,
  skillToolProvider,
  taskResultToolProvider,
  taskToolProvider,
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
  { provider: globToolProvider, phase: "pre-skill-visibility" },
  { provider: grepToolProvider, phase: "pre-skill-visibility" },
  { provider: notebookToolProvider, phase: "pre-skill-visibility" },
  { provider: mediaToolProvider, phase: "pre-skill-visibility" },
  { provider: voiceToolProvider, phase: "pre-skill-visibility" },
  { provider: imageGenerationToolProvider, phase: "pre-skill-visibility" },
  { provider: visionToolProvider, phase: "pre-skill-visibility" },
  { provider: processToolProvider, phase: "pre-skill-visibility" },
  { provider: workspaceTrustToolProvider, phase: "pre-skill-visibility" },
  { provider: configToolProvider, phase: "pre-skill-visibility" },
  { provider: cronToolProvider, phase: "pre-skill-visibility" },
  { provider: memoryToolProvider, phase: "pre-skill-visibility" },
  { provider: memoryRetrievalToolProvider, phase: "pre-skill-visibility" },
  { provider: memoryFileCompactionToolProvider, phase: "pre-skill-visibility" },
  { provider: sessionSearchToolProvider, phase: "pre-skill-visibility" },
  { provider: taskResultToolProvider, phase: "pre-skill-visibility" },
  { provider: taskToolProvider, phase: "pre-skill-visibility" },
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
