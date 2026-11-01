import { randomUUID } from "node:crypto";
import { createSQLiteSessionDB } from "../session/session-setup.js";
import { SQLiteProviderSpendController } from "../tasks/sqlite-provider-spend.js";
import { createProviderUsageRecorder } from "../providers/provider-usage-ledger.js";
import { ProviderExecutor } from "../providers/provider-executor.js";
import { join } from "node:path";
import { open, constants } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import type { CliCommandResult, CliOptions } from "./cli.js";
import { resolveHomeDir } from "../config/home-dir.js";
import { defaultProfileId, readActiveProfile, resolveProfileStateHome } from "../config/profile-home.js";
import { SkillRegistry } from "../skills/skill-registry.js";
import { loadSkillsFromDirectory } from "../skills/skill-loader.js";
import { SkillEvolutionStore } from "../skills/skill-evolution.js";
import { ChangeManifestStore } from "../skills/change-manifest-store.js";
import { SkillProposalService, type ProposalReviewDetails } from "../skills/skill-proposal-service.js";

function resolveHome(options: CliOptions): string {
  return resolveHomeDir(options.homeDir);
}

async function openProposalService(options: CliOptions): Promise<SkillProposalService> {
  const home = resolveHome(options);
  const profileId = options.profileId ?? readActiveProfile({ homeDir: home }).profileId ?? defaultProfileId();
  const localSkillsRoot = resolveProfileStateHome({ homeDir: home, profileId }).skillsPath;
  const registry = new SkillRegistry();
  const config = await loadRuntimeConfig({ workspaceRoot: options.workspaceRoot, homeDir: home, profileId, configurationInspection: true });
  // Match runtime source precedence without starting providers or loading secrets.
  const sources = [
    { root: join(localSkillsRoot, "packs"), kind: "external" as const },
    { root: fileURLToPath(new URL("../../skills/official", import.meta.url)), kind: "bundled" as const },
    { root: localSkillsRoot, kind: "local" as const },
    ...config.skills.externalDirs.map((root) => ({ root, kind: "external" as const }))
  ];
  for (const { root, kind } of sources) {
    const loaded = await loadSkillsFromDirectory(root, {
      sourceKind: kind, sourceRoot: root, ...(kind === "local" ? { exclude: ["packs"] } : {})
    });
    for (const skill of loaded.skills) registry.register(skill);
  }
  const skillEvolutionStore = new SkillEvolutionStore({
    profileRoot: localSkillsRoot,
    usagePath: join(localSkillsRoot, ".usage.json"),
    evolutionRoot: join(localSkillsRoot, ".evolution")
  });
  const changeManifestStore = new ChangeManifestStore({
    root: join(localSkillsRoot, ".evolution", "manifests")
  });
  return new SkillProposalService({
    registry,
    localSkillsRoot,
    skillEvolutionStore,
    changeManifestStore
  });
}

export async function proposalCommand(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const [subcommand, ...restArgs] = args;
  // Pin one profile across source loading, credential resolution, execution and recording.
  options = { ...options, profileId: options.profileId ?? readActiveProfile({ homeDir: resolveHome(options) }).profileId ?? defaultProfileId() };

  const service = await openProposalService(options);

  switch (subcommand) {
    case "list":
      return proposalList(service, restArgs);
    case "inspect":
      return proposalInspect(service, restArgs);
    case "approve":
      return proposalApprove(service, restArgs);
    case "reject":
      return proposalReject(service, restArgs);
    case "promote":
      return proposalPromote(service, restArgs);
    case "test": {
      const [id, suitePath] = restArgs;
      if (!id || !suitePath) return { handled: true, exitCode: 1, output: "Usage: estacoda proposal test <id> <task-suite.json>" };
      let executor: ProviderExecutor | undefined;
      let db: Awaited<ReturnType<typeof createSQLiteSessionDB>> | undefined;
      try {
        const file = await open(suitePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        let suite: unknown;
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > 128_000) throw new Error("Task suite must be a regular file up to 128 KB.");
          const buffer = Buffer.alloc(128_001);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          if (bytesRead > 128_000) throw new Error("Task suite exceeds 128 KB.");
          suite = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
        } finally { await file.close(); }
        const config = await loadRuntimeConfig({ workspaceRoot: options.workspaceRoot, homeDir: resolveHome(options), profileId: options.profileId });
        if (config.primaryModelRoute.provider === "unconfigured") throw new Error("Configure a model before running task evaluations.");
        db = await createSQLiteSessionDB({ homeDir: resolveHome(options) });
        const sessionId = randomUUID();
        await db.createSession({ id: sessionId, profileId: config.profileId, title: "Skill task evaluation",
          ...(config.budgets.session ? { spendingScopeSessionId: sessionId, spendingLimit: config.budgets.session } : {}) });
        const ledger = db;
        executor = new ProviderExecutor({ registry: config.providerRegistry, homeDir: resolveHome(options), profileId: config.profileId,
          spendController: new SQLiteProviderSpendController({ db: db.db, profileId: config.profileId }),
          usageRecorder: createProviderUsageRecorder({ profileId: config.profileId, record: entries => ledger.recordProviderUsageEntries(entries) }) });
        const result = await service.runTaskEvaluation(id, { suite, executor, route: config.primaryModelRoute, sessionId });
        return { handled: true, exitCode: result.passed ? 0 : 1,
          output: `${result.passed ? "Executed paired task evaluation passed; approval is still required." : `Evaluation did not establish improvement: ${result.reason}`}\nEvidence: ${result.directory}` };
      } catch (error) {
        return { handled: true, exitCode: 1, output: error instanceof Error ? error.message : String(error) };
      } finally { await executor?.dispose(); db?.close(); }
    }
    case "evaluate": {
      const [id, reportPath] = restArgs;
      if (!id || !reportPath) return { handled: true, exitCode: 1, output: "Usage: estacoda proposal evaluate <id> <paired-task-report.json>" };
      try {
        const file = await open(reportPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        let report: unknown;
        try {
          if (!(await file.stat()).isFile()) throw new Error("Task report must be a regular file.");
          const buffer = Buffer.alloc(128_001);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          if (bytesRead > 128_000) throw new Error("Task report exceeds 128 KB.");
          report = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
        } finally { await file.close(); }
        await service.recordTaskEvaluation(id, report);
        return { handled: true, exitCode: 0, output: "Paired task evaluation recorded as operator-attested evidence. Review and approve the proposal before promotion." };
      } catch (error) {
        return { handled: true, exitCode: 1, output: error instanceof Error ? error.message : String(error) };
      }
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return {
        handled: true,
        exitCode: 0,
        output: proposalHelp()
      };
    default:
      return {
        handled: true,
        exitCode: 1,
        output: `Unknown proposal subcommand: ${subcommand}\n\n${proposalHelp()}`
      };
  }
}

function proposalHelp(): string {
  return [
    "EstaCoda proposal commands",
    "  estacoda proposal list                 List proposals with review metadata",
    "  estacoda proposal list --skill <name>  Filter by skill name",
    "  estacoda proposal list --status <s>    Filter by status (proposed|promoted|rejected)",
    "  estacoda proposal inspect <id>         Show proposal details with linked review records",
    "  estacoda proposal approve <id>         Mark proposal as approved",
    "  estacoda proposal test <id> <json>     Run paid, tool-free paired tasks on the configured model",
    "  estacoda proposal evaluate <id> <json> Record operator-attested paired task results; resets approval",
    "  estacoda proposal reject <id>          Reject a proposal",
    "  estacoda proposal promote <id>         Promote proposal after eval gates"
  ].join("\n");
}

async function proposalList(service: SkillProposalService, args: string[]): Promise<CliCommandResult> {
  const skillName = valueAfter(args, "--skill");
  const status = valueAfter(args, "--status") as "proposed" | "promoted" | "rejected" | undefined;

  const proposals = await service.listProposals({ skillName, status });

  if (proposals.length === 0) {
    return {
      handled: true,
      exitCode: 0,
      output: "No proposals found."
    };
  }

  const details = await Promise.all(proposals.map((proposal) => service.reviewProposalDetails(proposal)));
  const lines = details.flatMap(renderProposalReviewListItem);

  return {
    handled: true,
    exitCode: 0,
    output: ["Proposal review queue", ...lines].join("\n")
  };
}

async function proposalInspect(service: SkillProposalService, args: string[]): Promise<CliCommandResult> {
  const id = args[0];
  if (id === undefined) {
    return {
      handled: true,
      exitCode: 1,
      output: "Usage: estacoda proposal inspect <proposal-id>"
    };
  }

  const proposal = await service.findProposal(id);
  if (proposal === undefined) {
    return {
      handled: true,
      exitCode: 1,
      output: `Proposal not found: ${id}`
    };
  }

  const details = await service.reviewProposalDetails(proposal);
  return {
    handled: true,
    exitCode: 0,
    output: JSON.stringify(details, null, 2)
  };
}

async function proposalApprove(service: SkillProposalService, args: string[]): Promise<CliCommandResult> {
  const id = args[0];
  if (id === undefined) {
    return {
      handled: true,
      exitCode: 1,
      output: "Usage: estacoda proposal approve <proposal-id>"
    };
  }

  const proposal = await service.approveProposal(id, "cli");
  if (proposal === undefined) {
    return {
      handled: true,
      exitCode: 1,
      output: `Proposal not found: ${id}`
    };
  }

  return {
    handled: true,
    exitCode: 0,
    output: `Approved proposal ${proposal.id} for ${proposal.skillName}.`
  };
}

async function proposalReject(service: SkillProposalService, args: string[]): Promise<CliCommandResult> {
  const id = args[0];
  if (id === undefined) {
    return {
      handled: true,
      exitCode: 1,
      output: "Usage: estacoda proposal reject <proposal-id>"
    };
  }

  const proposal = await service.rejectProposal(id);
  if (proposal === undefined) {
    return {
      handled: true,
      exitCode: 1,
      output: `Proposal not found: ${id}`
    };
  }

  return {
    handled: true,
    exitCode: 0,
    output: `Rejected proposal ${proposal.id} for ${proposal.skillName}.`
  };
}

async function proposalPromote(service: SkillProposalService, args: string[]): Promise<CliCommandResult> {
  const id = args[0];
  if (id === undefined) {
    return {
      handled: true,
      exitCode: 1,
      output: "Usage: estacoda proposal promote <proposal-id>"
    };
  }

  const result = await service.promoteProposal(id);
  if (!result.ok) {
    return {
      handled: true,
      exitCode: 1,
      output: `Promotion blocked: ${result.reason}`
    };
  }

  return {
    handled: true,
    exitCode: 0,
    output: [
      `Promoted proposal ${id} into ${result.skill.name}.`,
      `Eval gate: ${result.evalGate.status}`,
      `Snapshot: ${result.snapshotPath}`
    ].join("\n")
  };
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

function renderProposalReviewListItem(details: ProposalReviewDetails): string[] {
  const proposal = details.proposal;
  const policyDecision = proposal.policyDecision;
  const evalPlan = proposal.evalPlan;
  const latestEvalRun = latestByTimestamp(details.evalRuns, (run) => run.ranAt);
  const evalStatus = details.review.evalResult?.status
    ?? (latestEvalRun === undefined ? "not recorded" : latestEvalRun.passed ? "passed" : "failed");
  return [
    "",
    `- ${proposal.id}`,
    `  status: ${proposal.status}`,
    `  skill: ${proposal.skillName}`,
    `  changeKind: ${proposal.changeKind ?? "skill_patch"}`,
    `  targetSurface: ${proposal.targetSurface ?? "skill"}`,
    `  affectedSurface: ${proposal.affectedSurface ?? proposal.skillName}`,
    `  affectedFiles: ${formatList(proposal.affectedFiles)}`,
    `  riskClass: ${proposal.riskClass ?? details.review.riskLevel}`,
    `  authorityExpansion: ${String(proposal.authorityExpansion ?? false)}`,
    `  sourceKind: ${proposal.sourceKind ?? proposal.source ?? "unknown"}`,
    `  evidenceIds: ${formatList(proposal.evidenceIds ?? proposal.evidence.observations)}`,
    `  learningCandidateIds: ${formatList(details.linkedLearningCandidates.map((candidate) => candidate.id))}`,
    `  experimentId: ${proposal.experimentId ?? "none"}`,
    `  experimentSummary: ${formatExperimentSummary(details.linkedExperiment)}`,
    `  hypothesis: ${proposal.hypothesis ?? proposal.reason}`,
    `  evalPlan: ${formatEvalPlan(evalPlan)}`,
    `  evalResult: ${evalStatus}`,
    `  rollbackExpectation: ${proposal.rollbackExpectation ?? "not recorded"}`,
    `  policyDecision: ${formatPolicyDecision(policyDecision)}`,
    `  recommendation: ${details.review.recommendedAction}`,
    `  approvalState: ${proposal.approvalState ?? "required"}`,
    `  createdAt: ${proposal.createdAt}`,
    `  updatedAt: ${proposal.promotedAt ?? proposal.rejectedAt ?? proposal.approvedAt ?? "not recorded"}`
  ];
}

function formatList(values: string[] | undefined): string {
  if (values === undefined || values.length === 0) {
    return "none";
  }
  return values.join(", ");
}

function formatEvalPlan(evalPlan: ProposalReviewDetails["proposal"]["evalPlan"]): string {
  if (evalPlan === undefined) {
    return "not recorded";
  }
  return [
    evalPlan.command === undefined ? undefined : `command=${evalPlan.command}`,
    evalPlan.constraintGates === undefined || evalPlan.constraintGates.length === 0
      ? undefined
      : `gates=${evalPlan.constraintGates.join(", ")}`,
    evalPlan.expectedMetrics === undefined || evalPlan.expectedMetrics.length === 0
      ? undefined
      : `metrics=${evalPlan.expectedMetrics.join(", ")}`
  ].filter((part): part is string => part !== undefined).join("; ") || "not recorded";
}

function formatPolicyDecision(policyDecision: ProposalReviewDetails["proposal"]["policyDecision"]): string {
  if (policyDecision === undefined) {
    return "not recorded";
  }
  return [
    `mode=${policyDecision.mode}`,
    `allowed=${policyDecision.allowed}`,
    `createProposals=${policyDecision.createProposals}`,
    `shadowOnly=${policyDecision.shadowOnly}`,
    `requiresApproval=${policyDecision.requiresApproval}`,
    policyDecision.reason === undefined ? undefined : `reason=${policyDecision.reason}`
  ].filter((part): part is string => part !== undefined).join("; ");
}

function formatExperimentSummary(experiment: ProposalReviewDetails["linkedExperiment"]): string {
  if (experiment === undefined) {
    return "not linked";
  }
  return `${experiment.id}; target=${experiment.targetSurface}; outcome=${experiment.outcome}; hypothesis=${experiment.hypothesis}`;
}

function latestByTimestamp<T>(values: T[], timestamp: (value: T) => string): T | undefined {
  return values.reduce<T | undefined>((latest, value) => {
    if (latest === undefined) {
      return value;
    }
    return timestamp(value) > timestamp(latest) ? value : latest;
  }, undefined);
}
