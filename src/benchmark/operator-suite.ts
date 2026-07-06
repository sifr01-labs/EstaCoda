import type { BenchmarkMetrics } from "./schema.js";

export const OPERATOR_SUITE_VERSION = "0.1.0";

export const OPERATOR_SCENARIO_CATEGORIES = [
  "bug-fix",
  "config-repair",
  "failure-recovery",
  "workspace-isolation",
  "repo-discovery",
  "memory-continuity",
  "docs-generation"
] as const;

export type OperatorScenarioCategory = typeof OPERATOR_SCENARIO_CATEGORIES[number];

export type OperatorScenarioContract = {
  objective: string;
  fixtureShape: string;
  expectedOutcome: string;
  verifierCommand: string;
  evidenceAssertions: string[];
  metricsWatched: Array<keyof BenchmarkMetrics>;
  knownNonGoals: string[];
};

export type OperatorScenarioDefinition = {
  id: string;
  category: OperatorScenarioCategory;
  deterministic: boolean;
  fixtureId: string;
  contract: OperatorScenarioContract;
};

export const OPERATOR_SCENARIO_REGISTRY: Record<OperatorScenarioCategory, OperatorScenarioDefinition[]> = {
  "bug-fix": [
    {
      id: "one-file-bug-diagnosis",
      category: "bug-fix",
      deterministic: true,
      fixtureId: "one-file-bug-diagnosis",
      contract: {
        objective: "Diagnose and fix a failing unit test caused by a one-file arithmetic bug.",
        fixtureShape: "Temporary JavaScript repository with src/totals.js, test/totals.test.js, instruction.txt, and verifier.sh.",
        expectedOutcome: "src/totals.js is patched minimally, the verifier passes, and the final answer names the tax-rate root cause.",
        verifierCommand: "sh verifier.sh <workspace>",
        evidenceAssertions: [
          "file inspected",
          "command attempted",
          "patch touches expected path",
          "final answer contains root cause",
          "metric under threshold",
          "event kind present"
        ],
        metricsWatched: ["toolCalls", "toolFailures", "providerIterations", "totalTokens", "estimatedCostUsd"],
        knownNonGoals: [
          "Do not measure general coding skill beyond the deterministic one-file fix.",
          "Do not require a live provider."
        ]
      }
    }
  ],
  "config-repair": [
    {
      id: "local-provider-base-url-repair",
      category: "config-repair",
      deterministic: true,
      fixtureId: "local-provider-base-url-repair",
      contract: {
        objective: "Repair a broken local OpenAI-compatible provider configuration.",
        fixtureShape: "Temporary setup repo with config/local-provider.json, scripts/verify-local-provider.js, instruction.txt, and verifier.sh.",
        expectedOutcome: "The base URL includes the required /v1 suffix and the verifier passes.",
        verifierCommand: "sh verifier.sh <workspace>",
        evidenceAssertions: [
          "file inspected",
          "command attempted",
          "patch touches expected path",
          "final answer contains root cause",
          "metric under threshold",
          "event kind absent"
        ],
        metricsWatched: ["toolCalls", "toolFailures", "providerBudgetExhaustions", "securityEscalations", "totalTokens"],
        knownNonGoals: [
          "Do not call the configured provider.",
          "Do not tune benchmark prompts for a specific model."
        ]
      }
    }
  ],
  "failure-recovery": [
    {
      id: "tool-failure-retry-recovery",
      category: "failure-recovery",
      deterministic: true,
      fixtureId: "tool-failure-retry-recovery",
      contract: {
        objective: "Recover from an injected runtime/tool failure and complete the requested verification.",
        fixtureShape: "Temporary repo with scripts/check-state.js, recovery.log expected by verifier.sh, and instruction.txt.",
        expectedOutcome: "The first command failure is recorded, recovery is attempted, recovery.log is written, and the verifier passes.",
        verifierCommand: "sh verifier.sh <workspace>",
        evidenceAssertions: [
          "command attempted",
          "patch touches expected path",
          "final answer contains root cause",
          "event kind present",
          "metric under threshold"
        ],
        metricsWatched: ["toolCalls", "toolFailures", "providerIterations", "providerBudgetExhaustions", "agentCancelled"],
        knownNonGoals: [
          "Do not make failure recovery a CI-blocking regression threshold.",
          "Do not require provider retry behavior from a live model."
        ]
      }
    }
  ],
  "workspace-isolation": [
    {
      id: "two-workspace-scope-isolation",
      category: "workspace-isolation",
      deterministic: true,
      fixtureId: "two-workspace-scope-isolation",
      contract: {
        objective: "Operate on the requested workspace while avoiding unrelated workspace context.",
        fixtureShape: "Temporary workspace containing workspace-a and workspace-b directories with separate project state.",
        expectedOutcome: "Only workspace-a/output.txt is written, workspace-b remains untouched, and no workspace-b private marker appears in artifacts.",
        verifierCommand: "sh verifier.sh <workspace>",
        evidenceAssertions: [
          "file inspected",
          "command attempted",
          "patch touches expected path",
          "forbidden path untouched",
          "no unrelated memory/context injected",
          "workspace path scoped correctly"
        ],
        metricsWatched: ["toolCalls", "toolFailures", "contextUsageEvents", "securityEscalations", "totalTokens"],
        knownNonGoals: [
          "Do not model multi-profile runtime routing.",
          "Do not inspect or mutate workspace-b to make the scenario pass."
        ]
      }
    }
  ],
  "repo-discovery": [
    {
      id: "architecture-entrypoint-discovery",
      category: "repo-discovery",
      deterministic: true,
      fixtureId: "architecture-entrypoint-discovery",
      contract: {
        objective: "Discover a fixture repository's entry point, request flow, and major components with evidence.",
        fixtureShape: "Temporary repository with package.json, src/server.js, src/router.js, src/services/orders.js, and verifier.sh.",
        expectedOutcome: "The final answer identifies src/server.js as entry point, the router flow, and the order service component.",
        verifierCommand: "sh verifier.sh <workspace>",
        evidenceAssertions: [
          "file inspected",
          "command attempted",
          "final answer contains root cause",
          "event kind present",
          "metric under threshold"
        ],
        metricsWatched: ["toolCalls", "toolFailures", "providerIterations", "contextUsageEvents", "totalTokens"],
        knownNonGoals: [
          "Do not grade broad natural-language style.",
          "Do not require browser or network research."
        ]
      }
    }
  ],
  "memory-continuity": [],
  "docs-generation": []
};

export function listOperatorScenarios(): OperatorScenarioDefinition[] {
  return OPERATOR_SCENARIO_CATEGORIES.flatMap((category) => OPERATOR_SCENARIO_REGISTRY[category]);
}

export function listDeterministicOperatorScenarios(): OperatorScenarioDefinition[] {
  return listOperatorScenarios().filter((scenario) => scenario.deterministic);
}
