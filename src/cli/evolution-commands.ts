import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { cp, rm, stat, writeFile } from "node:fs/promises";
import type { CliCommandResult, CliOptions } from "./cli.js";
import { SkillRegistry } from "../skills/skill-registry.js";
import { loadSkillsFromDirectory } from "../skills/skill-loader.js";
import { SkillEvolutionStore } from "../skills/skill-evolution.js";
import { ChangeManifestStore } from "../skills/change-manifest-store.js";
import { SkillProposalService, slugifySkillName } from "../skills/skill-proposal-service.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { createSQLiteSessionDB } from "../session/session-setup.js";
import { defaultProfileId, readActiveProfile, resolveGlobalStateHome, resolveProfileStateHome } from "../config/profile-home.js";
import { runConstraintGates } from "../evolution/constraint-gate-runner.js";
import { canTransition } from "../evolution/candidate-lifecycle.js";
import { populateTraces } from "../evolution/export-format.js";
import type { OptimizationDataset } from "../evolution/export-format.js";

function resolveHome(options: CliOptions): string {
  return options.homeDir ?? process.env.HOME ?? homedir();
}

async function openStores(options: CliOptions, storeOptions: { includeSessionDb?: boolean } = {}) {
  const home = resolveHome(options);
  const globalPaths = resolveGlobalStateHome({ homeDir: home });
  const profileId = readActiveProfile({ homeDir: home }).profileId ?? defaultProfileId();
  const profilePaths = resolveProfileStateHome({ homeDir: home, profileId });
  const localSkillsRoot = profilePaths.skillsPath;
  const registry = new SkillRegistry();
  const loaded = await loadSkillsFromDirectory(localSkillsRoot, {
    sourceKind: "local",
    sourceRoot: localSkillsRoot
  }).catch(() => ({ skills: [], errors: [] }));
  for (const skill of loaded.skills) {
    registry.register(skill);
  }
  const skillEvolutionStore = new SkillEvolutionStore({
    usagePath: join(localSkillsRoot, ".usage.json"),
    evolutionRoot: join(localSkillsRoot, ".evolution")
  });
  const changeManifestStore = new ChangeManifestStore({
    root: join(localSkillsRoot, ".evolution", "manifests")
  });
  const proposalService = new SkillProposalService({
    registry,
    localSkillsRoot,
    skillEvolutionStore,
    changeManifestStore
  });
  let sessionDb: SQLiteSessionDB | undefined;
  if (storeOptions.includeSessionDb === true) {
    try {
      sessionDb = await createSQLiteSessionDB({ path: globalPaths.sessionsSqlitePath });
    } catch {
      sessionDb = undefined;
    }
  }
  return { registry, skillEvolutionStore, changeManifestStore, proposalService, sessionDb, localSkillsRoot };
}

export async function evolutionCommand(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const [subcommand, ...restArgs] = args;

  switch (subcommand) {
    case "export":
      return evolutionExport(options, restArgs);
    case "test":
      return evolutionTest(options, restArgs);
    case "approve":
      return evolutionApprove(options, restArgs);
    case "reject":
      return evolutionReject(options, restArgs);
    case "promote":
      return evolutionPromote(options, restArgs);
    case "rollback":
      return evolutionRollback(options, restArgs);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return {
        handled: true,
        exitCode: 0,
        output: evolutionHelp()
      };
    default:
      return {
        handled: true,
        exitCode: 1,
        output: `Unknown evolution subcommand: ${subcommand}\n\n${evolutionHelp()}`
      };
  }
}

function evolutionHelp(): string {
  return [
    "EstaCoda evolution commands",
    "  estacoda evolution test <manifest-id> [--gate <gate-name>]   Run constraint gates",
    "  estacoda evolution approve <manifest-id> [--by <user>]       Approve a tested manifest",
    "  estacoda evolution reject <manifest-id> [--by <user>] [--reason <text>]  Reject a manifest",
    "  estacoda evolution promote <manifest-id> [--by <user>]       Promote an approved manifest",
    "  estacoda evolution rollback <manifest-id>                    Rollback a promoted manifest",
    "  estacoda evolution export --dataset <path>                   Export optimization dataset",
    "  estacoda evolution export --dataset <path> --since <iso-date>",
    "  estacoda evolution export --dataset <path> --skill <name>"
  ].join("\n");
}

async function evolutionTest(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const manifestId = args[0];
  const gateFilter = valueAfter(args, "--gate");

  if (manifestId === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda evolution test <manifest-id> [--gate <gate-name>]" };
  }

  const { changeManifestStore } = await openStores(options);
  const manifest = await changeManifestStore.find(manifestId);
  if (manifest === undefined) {
    return { handled: true, exitCode: 1, output: `Manifest not found: ${manifestId}` };
  }

  const transition = canTransition(manifest.status, "test");
  if (!transition.ok) {
    return { handled: true, exitCode: 1, output: transition.reason };
  }

  const gates: string[] = [
    ...(manifest.evalCommand ? [manifest.evalCommand] : []),
    ...(manifest.constraintGates ?? [])
  ];

  if (gates.length === 0) {
    return {
      handled: true,
      exitCode: 1,
      output: "No allowed gates defined. At least one validation gate is required before approval."
    };
  }

  const filteredGates = gateFilter !== undefined ? gates.filter((g) => normalizeCommand(g) === normalizeCommand(gateFilter)) : gates;

  await changeManifestStore.updateStatus(manifestId, "testing");

  const results = await runConstraintGates(filteredGates, { cwd: options.workspaceRoot });
  const failures = results.filter((r) => !r.passed);

  if (failures.length > 0) {
    await changeManifestStore.updateStatus(manifestId, "rejected");
    const lines = failures.map((f) => {
      if (f.rejectionReason) {
        return `  [BLOCKED] ${f.gate}: ${f.rejectionReason}`;
      }
      return `  [FAIL] ${f.gate}: exit ${f.exitCode}${f.timedOut ? " (timed out)" : ""}`;
    });
    return {
      handled: true,
      exitCode: 1,
      output: [`Gate failures:`, ...lines].join("\n")
    };
  }

  const summary = results.map((r) => `  [PASS] ${r.gate} (${r.durationMs}ms)`).join("\n");
  return {
    handled: true,
    exitCode: 0,
    output: [`All gates passed (${results.length}):`, summary].join("\n")
  };
}

async function evolutionApprove(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const manifestId = args[0];
  const approvedBy = valueAfter(args, "--by") ?? process.env.USER ?? "cli";

  if (manifestId === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda evolution approve <manifest-id> [--by <user>]" };
  }

  const { changeManifestStore, proposalService, skillEvolutionStore } = await openStores(options);
  const manifest = await changeManifestStore.find(manifestId);
  if (manifest === undefined) {
    return { handled: true, exitCode: 1, output: `Manifest not found: ${manifestId}` };
  }

  const transition = canTransition(manifest.status, "approve");
  if (!transition.ok) {
    return { handled: true, exitCode: 1, output: transition.reason };
  }

  const linkedProposal = await findLinkedProposal(skillEvolutionStore, manifestId);
  if (linkedProposal !== undefined) {
    const proposal = await proposalService.approveProposal(linkedProposal.id, approvedBy);
    if (proposal === undefined) {
      return { handled: true, exitCode: 1, output: "Linked proposal approval failed." };
    }
  }

  await changeManifestStore.updateStatus(manifestId, "approved");

  return {
    handled: true,
    exitCode: 0,
    output: `Manifest ${manifestId} approved.`
  };
}

async function evolutionReject(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const manifestId = args[0];
  const rejectedBy = valueAfter(args, "--by") ?? process.env.USER ?? "cli";
  const reason = valueAfter(args, "--reason");

  if (manifestId === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda evolution reject <manifest-id> [--by <user>] [--reason <text>]" };
  }

  const { changeManifestStore, proposalService, skillEvolutionStore } = await openStores(options);
  const manifest = await changeManifestStore.find(manifestId);
  if (manifest === undefined) {
    return { handled: true, exitCode: 1, output: `Manifest not found: ${manifestId}` };
  }

  const transition = canTransition(manifest.status, "reject");
  if (!transition.ok) {
    return { handled: true, exitCode: 1, output: transition.reason };
  }

  const linkedProposal = await findLinkedProposal(skillEvolutionStore, manifestId);
  if (linkedProposal !== undefined) {
    await proposalService.rejectProposal(linkedProposal.id);
  }

  await changeManifestStore.updateStatus(manifestId, "rejected");

  const reasonLine = reason !== undefined ? ` Reason: ${reason}` : "";
  return {
    handled: true,
    exitCode: 0,
    output: `Manifest ${manifestId} rejected by ${rejectedBy}.${reasonLine}`
  };
}

async function evolutionPromote(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const manifestId = args[0];
  const promotedBy = valueAfter(args, "--by") ?? process.env.USER ?? "cli";

  if (manifestId === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda evolution promote <manifest-id> [--by <user>]" };
  }

  const { changeManifestStore, proposalService, skillEvolutionStore } = await openStores(options);
  const manifest = await changeManifestStore.find(manifestId);
  if (manifest === undefined) {
    return { handled: true, exitCode: 1, output: `Manifest not found: ${manifestId}` };
  }

  const transition = canTransition(manifest.status, "promote");
  if (!transition.ok) {
    return { handled: true, exitCode: 1, output: transition.reason };
  }

  if (manifest.target === "runtime_code" || manifest.target === "middleware") {
    return {
      handled: true,
      exitCode: 1,
      output: `Promotion blocked: target '${manifest.target}' is not permitted in v0.1.0.`
    };
  }

  if (manifest.target !== "skill") {
    return {
      handled: true,
      exitCode: 1,
      output: `Promotion for target '${manifest.target}' is not supported in v0.1.0.`
    };
  }

  const linkedProposal = await findLinkedProposal(skillEvolutionStore, manifestId);
  if (linkedProposal === undefined) {
    return {
      handled: true,
      exitCode: 1,
      output: "Skill promotion requires a linked SkillPatchProposal."
    };
  }

  const proposal = await proposalService.findProposal(linkedProposal.id);
  if (proposal === undefined || proposal.status !== "proposed") {
    return {
      handled: true,
      exitCode: 1,
      output: "Linked proposal not found or not in a promotable state."
    };
  }

  // Re-run constraint gates before promotion
  const gates: string[] = [
    ...(manifest.evalCommand ? [manifest.evalCommand] : []),
    ...(manifest.constraintGates ?? [])
  ];
  if (gates.length > 0) {
    const gateResults = await runConstraintGates(gates, { cwd: options.workspaceRoot });
    const gateFailures = gateResults.filter((r) => !r.passed);
    if (gateFailures.length > 0) {
      const lines = gateFailures.map((f) => {
        if (f.rejectionReason) return `  [BLOCKED] ${f.gate}: ${f.rejectionReason}`;
        return `  [FAIL] ${f.gate}: exit ${f.exitCode}${f.timedOut ? " (timed out)" : ""}`;
      });
      return {
        handled: true,
        exitCode: 1,
        output: [`Pre-promotion gate failures:`, ...lines].join("\n")
      };
    }
  }

  const result = await proposalService.promoteProposal(proposal.id);
  if (!result.ok) {
    return { handled: true, exitCode: 1, output: `Promotion failed: ${result.reason}` };
  }

  await changeManifestStore.updateStatus(manifestId, "promoted", { promotedBy });

  return {
    handled: true,
    exitCode: 0,
    output: `Manifest ${manifestId} promoted. Snapshot: ${result.snapshotPath}`
  };
}

async function evolutionRollback(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const manifestId = args[0];

  if (manifestId === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda evolution rollback <manifest-id>" };
  }

  const { changeManifestStore, skillEvolutionStore, localSkillsRoot, registry } = await openStores(options);
  const manifest = await changeManifestStore.find(manifestId);
  if (manifest === undefined) {
    return { handled: true, exitCode: 1, output: `Manifest not found: ${manifestId}` };
  }

  const transition = canTransition(manifest.status, "rollback");
  if (!transition.ok) {
    return { handled: true, exitCode: 1, output: transition.reason };
  }

  if (manifest.target !== "skill") {
    return {
      handled: true,
      exitCode: 1,
      output: `Rollback not supported because promotion was not supported for target '${manifest.target}' in v0.1.0.`
    };
  }

  const linkedProposal = await findLinkedProposal(skillEvolutionStore, manifestId);
  if (linkedProposal === undefined) {
    return {
      handled: true,
      exitCode: 1,
      output: "Rollback failed: no linked proposal found."
    };
  }

  const promotionId = linkedProposal.promotionId;
  let promotion: import("../skills/skill-evolution.js").SkillPromotionRecord | undefined;

  if (promotionId !== undefined) {
    promotion = await skillEvolutionStore.findPromotion(promotionId);
  }

  if (promotion === undefined) {
    const promotions = await skillEvolutionStore.listPromotions({ skillName: linkedProposal.skillName });
    promotion = promotions.at(-1);
  }

  if (promotion?.snapshotPath === undefined) {
    return {
      handled: true,
      exitCode: 1,
      output: "Rollback failed: promotion snapshot not found."
    };
  }

  const snapshotPath = promotion.snapshotPath;
  const skillFile = await stat(join(snapshotPath, "SKILL.md")).catch(() => undefined);
  if (skillFile === undefined || !skillFile.isFile()) {
    return {
      handled: true,
      exitCode: 1,
      output: `Rollback failed: promotion snapshot missing SKILL.md: ${snapshotPath}`
    };
  }

  const skill = registry.get(linkedProposal.skillName);
  const skillDir = skill !== undefined && "sourcePath" in skill
    ? dirname(skill.sourcePath)
    : join(localSkillsRoot, slugifySkillName(linkedProposal.skillName));
  await rm(skillDir, { recursive: true, force: true });
  await cp(snapshotPath, skillDir, { recursive: true });

  await changeManifestStore.updateStatus(manifestId, "reverted");

  return {
    handled: true,
    exitCode: 0,
    output: [
      `Rolled back manifest ${manifestId} for skill '${linkedProposal.skillName}'.`,
      `Snapshot restored from: ${snapshotPath}`,
      `Rollback plan (display only): ${manifest.rollbackPlan}`
    ].join("\n")
  };
}

async function evolutionExport(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const datasetPath = valueAfter(args, "--dataset");
  const sinceRaw = valueAfter(args, "--since");
  const skillName = valueAfter(args, "--skill");

  if (datasetPath === undefined) {
    return {
      handled: true,
      exitCode: 1,
      output: "Usage: estacoda evolution export --dataset <path> [--since <iso-date>] [--skill <name>]"
    };
  }

  const since = sinceRaw !== undefined ? new Date(sinceRaw) : undefined;
  if (sinceRaw !== undefined && Number.isNaN(since?.getTime())) {
    return {
      handled: true,
      exitCode: 1,
      output: `Invalid --since date: ${sinceRaw}`
    };
  }

  const { skillEvolutionStore, changeManifestStore, sessionDb } = await openStores(options, { includeSessionDb: true });

  try {
    const proposals = await skillEvolutionStore.listProposals({});
    const observations = await skillEvolutionStore.listObservations({});
    const evalRuns = await skillEvolutionStore.listEvalRuns();
    const manifests = await changeManifestStore.list({});

    const filteredProposals = skillName !== undefined
      ? proposals.filter((p) => p.skillName === skillName)
      : proposals;
    const filteredObservations = skillName !== undefined
      ? observations.filter((o) => o.skillName === skillName)
      : observations;
    const filteredManifests = skillName !== undefined
      ? manifests.filter((m) => m.filesChanged.some((f) => f.includes(skillName)))
      : manifests;

    const sinceTime = since?.getTime() ?? 0;

    const traces = await populateTraces(filteredManifests, sessionDb);

    const dataset: OptimizationDataset = {
      version: "v0.7",
      generatedAt: new Date().toISOString(),
      meta: {
        skillCount: new Set([
          ...filteredProposals.map((p) => p.skillName),
          ...filteredObservations.map((o) => o.skillName)
        ]).size,
        proposalCount: filteredProposals.length,
        manifestCount: filteredManifests.length,
        observationCount: filteredObservations.length,
        evalRunCount: evalRuns.length
      },
      traces,
      skillEvalRuns: evalRuns.map((r: import("../skills/skill-evolution.js").SkillEvalRunRecord) => ({
        skillName: r.skillName,
        evalId: r.evalId,
        score: r.score,
        passed: r.passed,
        details: r.details ?? {}
      })),
      observations: filteredObservations
        .filter((o) => new Date(o.timestamp).getTime() >= sinceTime)
        .map((o) => ({
          id: o.id,
          skillName: o.skillName,
          type: o.type,
          lesson: o.lesson,
          outcome: o.outcome,
          toolsAttempted: o.toolsAttempted ?? []
        })),
      proposals: filteredProposals
        .filter((p) => new Date(p.createdAt).getTime() >= sinceTime)
        .map((p) => ({
          id: p.id,
          skillName: p.skillName,
          status: p.status
        })),
      manifests: filteredManifests
        .filter((m) => new Date(m.createdAt).getTime() >= sinceTime)
        .map((m) => ({
          id: m.id,
          target: m.target,
          status: m.status,
          hypothesis: m.hypothesis,
          predictedImpact: m.predictedImpact,
          riskLevel: m.riskLevel,
          filesChanged: m.filesChanged,
          evidenceTraces: m.evidence.traces,
          constraintGates: m.constraintGates,
          rollbackPlan: m.rollbackPlan,
          createdAt: m.createdAt
        }))
    };

    await writeFile(datasetPath, JSON.stringify(dataset, null, 2), "utf8");

    return {
      handled: true,
      exitCode: 0,
      output: [
        `Exported optimization dataset to ${datasetPath}`,
        `  Proposals: ${dataset.meta.proposalCount}`,
        `  Manifests: ${dataset.meta.manifestCount}`,
        `  Observations: ${dataset.meta.observationCount}`,
        `  Eval runs: ${dataset.meta.evalRunCount}`,
        `  Traces: ${dataset.traces.length}`
      ].join("\n")
    };
  } finally {
    sessionDb?.close();
  }
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

function normalizeCommand(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

async function findLinkedProposal(
  skillEvolutionStore: SkillEvolutionStore,
  manifestId: string
): Promise<import("../skills/skill-evolution.js").SkillPatchProposal | undefined> {
  const proposals = await skillEvolutionStore.listProposals({});
  return proposals.find((p) => p.changeManifestId === manifestId);
}
