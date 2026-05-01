import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { LoadedSkill, SkillDefinition, SkillEvaluation } from "../contracts/skill.js";
import type { RegisteredTool, ToolResult } from "../contracts/tool.js";
import { SkillEvolutionStore, type SkillEvalRunRecord, type SkillObservationRecord, type SkillPatchOperation, type SkillPatchProposal, type SkillPatchRiskLevel, type SkillSourceTrust } from "./skill-evolution.js";
import { resetBundledSkill } from "./skill-bundled-sync.js";
import { MAX_SKILL_RESOURCE_BYTES, MAX_SKILL_RESOURCE_CHARS } from "./skill-limits.js";
import { hydrateSkillResources, loadSkillsFromDirectory, parseSkillFile, truncateContextDocument } from "./skill-loader.js";
import { assertSkillContentMutationAllowed, assertSkillMutable } from "./skill-mutation-policy.js";
import { ensureContainedDirectory, isSafeRelativeSkillPath } from "./skill-path-safety.js";
import type { SkillRegistry } from "./skill-registry.js";

export type SkillToolsOptions = {
  registry: SkillRegistry;
  visibleRegistry?: SkillRegistry;
  localSkillsRoot: string;
  bundledSkillsRoot?: string;
  skillEvolutionStore?: SkillEvolutionStore;
};

export function createSkillTools(options: SkillToolsOptions): readonly RegisteredTool[] {
  return [
    {
      name: "skill.list",
      description: "List available skills with source and category metadata.",
      inputSchema: {
        type: "object",
        properties: {
          category: { type: "string" }
        }
      },
      riskClass: "read-only-local",
      toolsets: ["core", "research"],
      progressLabel: "listing skills",
      maxResultSizeChars: 12_000,
      isAvailable: () => true,
      run: async (input: { category?: string }) => {
        const catalog = (options.visibleRegistry ?? options.registry).catalog()
          .filter((skill) => input.category === undefined || skill.category === input.category);

        return {
          ok: true,
          content: catalog.length === 0
            ? "No skills found."
            : catalog
                .map((skill) => `${skill.name}\t${skill.category}\t${skill.sourceKind ?? "runtime"}\t${skill.description}`)
                .join("\n"),
          metadata: {
            count: catalog.length,
            skills: catalog
          }
        };
      }
    },
    {
      name: "skill.view",
      description: "View full instructions for a loaded skill.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          path: { type: "string" }
        },
        required: ["name"]
      },
      riskClass: "read-only-local",
      toolsets: ["core", "research"],
      progressLabel: "viewing skill",
      maxResultSizeChars: 24_000,
      isAvailable: () => true,
      run: async (input: { name?: string; path?: string }) => {
        const skill = getSkill(options.registry, input.name);
        if (!skill.ok) {
          return skill;
        }
        const foundSkill = skill.skill;
        await options.skillEvolutionStore?.recordSkillViewed({
          skillName: foundSkill.name,
          source: isLoadedSkill(foundSkill) ? foundSkill.sourceKind : undefined,
          provenanceKind: "provenance" in foundSkill ? foundSkill.provenance?.kind : undefined
        });

        if (isLoadedSkill(foundSkill) && isNonEmptyString(input.path)) {
          return readSkillReference(foundSkill, input.path);
        }

        return {
          ok: true,
          content: "instructions" in foundSkill
            ? `# ${foundSkill.name}\n\n${foundSkill.instructions}`
            : `# ${foundSkill.name}\n\n${foundSkill.description}`,
          metadata: toSkillMetadata(foundSkill)
        };
      }
    },
    {
      name: "skill.inspect",
      description: "Inspect skill metadata, workflow, examples, and evaluations without loading extra files.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" }
        },
        required: ["name"]
      },
      riskClass: "read-only-local",
      toolsets: ["core", "research"],
      progressLabel: "inspecting skill",
      maxResultSizeChars: 16_000,
      isAvailable: () => true,
      run: async (input: { name?: string }) => {
        const skill = getSkill(options.registry, input.name);
        if (!skill.ok) {
          return skill;
        }
        const foundSkill = skill.skill;
        await options.skillEvolutionStore?.recordSkillViewed({
          skillName: foundSkill.name,
          source: isLoadedSkill(foundSkill) ? foundSkill.sourceKind : undefined,
          provenanceKind: "provenance" in foundSkill ? foundSkill.provenance?.kind : undefined
        });

        return {
          ok: true,
          content: JSON.stringify(toSkillMetadata(foundSkill), null, 2),
          metadata: toSkillMetadata(foundSkill)
        };
      }
    },
    {
      name: "skill.eval",
      description: "Run lightweight skill eval gates for routing, workflow tool expectations, and degraded behavior metadata.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" }
        },
        required: ["name"]
      },
      riskClass: "read-only-local",
      toolsets: ["core", "research"],
      progressLabel: "running skill evals",
      maxResultSizeChars: 12_000,
      isAvailable: () => true,
      run: async (input: { name?: string }) => {
        const skill = getSkill(options.registry, input.name);
        if (!skill.ok) {
          return skill;
        }
        const result = await runSkillEvalGate(skill.skill);
        if (options.skillEvolutionStore !== undefined) {
          await recordSkillEvalRuns(options.skillEvolutionStore, skill.skill.name, result);
        }
        return {
          ok: result.status !== "failed",
          content: JSON.stringify(result, null, 2),
          metadata: result
        };
      }
    },
    {
      name: "skill.usage",
      description: "Inspect per-skill usage, success/failure, patch, rollback, and lifecycle counters.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" }
        }
      },
      riskClass: "read-only-local",
      toolsets: ["core", "research"],
      progressLabel: "inspecting skill usage",
      maxResultSizeChars: 12_000,
      isAvailable: () => options.skillEvolutionStore !== undefined,
      run: async (input: { name?: string }) => {
        if (options.skillEvolutionStore === undefined) {
          return errorResult("Skill usage store is not configured.");
        }
        const usage = isNonEmptyString(input.name)
          ? await options.skillEvolutionStore.getUsage(input.name)
          : await options.skillEvolutionStore.usage();
        return {
          ok: true,
          content: JSON.stringify(usage ?? null, null, 2),
          metadata: {
            usage
          }
        };
      }
    },
    {
      name: "skill.observe",
      description: "Record an append-only skill learning observation without mutating SKILL.md.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          type: { type: "string" },
          lesson: { type: "string" },
          promptSummary: { type: "string" },
          selectedWorkflowStep: { type: "string" },
          toolsAttempted: { type: "array", items: { type: "string" } },
          outcome: { type: "string" },
          candidateImprovement: { type: "string" },
          sourceTrust: { type: "string" },
          mayPromoteAutomatically: { type: "boolean" },
          requiresHumanApproval: { type: "boolean" }
        },
        required: ["name", "type", "lesson"]
      },
      riskClass: "workspace-write",
      toolsets: ["core", "files", "research"],
      progressLabel: "recording skill observation",
      maxResultSizeChars: 4000,
      isAvailable: () => options.skillEvolutionStore !== undefined,
      run: async (input: {
        name?: string;
        type?: "success" | "failure" | "blocked" | "partial" | "note";
        lesson?: string;
        promptSummary?: string;
        selectedWorkflowStep?: string;
        toolsAttempted?: string[];
        outcome?: "succeeded" | "failed" | "blocked" | "partial";
        candidateImprovement?: string;
        sourceTrust?: SkillSourceTrust;
        mayPromoteAutomatically?: boolean;
        requiresHumanApproval?: boolean;
      }) => {
        if (options.skillEvolutionStore === undefined) {
          return errorResult("Skill evolution store is not configured.");
        }
        if (!isNonEmptyString(input.name) || !isNonEmptyString(input.type) || !isNonEmptyString(input.lesson)) {
          return errorResult("skill.observe requires name, type, and lesson");
        }
        const skill = options.registry.get(input.name);
        const observation = await options.skillEvolutionStore.appendObservation({
          skillName: input.name,
          source: skill !== undefined && isLoadedSkill(skill) ? skill.sourceKind : undefined,
          type: input.type,
          lesson: input.lesson,
          promptSummary: input.promptSummary,
          selectedWorkflowStep: input.selectedWorkflowStep,
          toolsAttempted: input.toolsAttempted,
          outcome: input.outcome,
          candidateImprovement: input.candidateImprovement,
          sourceTrust: normalizeSourceTrust(input.sourceTrust),
          mayPromoteAutomatically: input.mayPromoteAutomatically,
          requiresHumanApproval: input.requiresHumanApproval
        });
        return {
          ok: true,
          content: `Recorded skill observation ${observation.id} for ${observation.skillName}.`,
          metadata: observation
        };
      }
    },
    {
      name: "skill.propose_patch",
      description: "Record a candidate skill improvement as a proposed patch without mutating SKILL.md.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          reason: { type: "string" },
          confidence: { type: "number" },
          observationIds: { type: "array", items: { type: "string" } },
          successes: { type: "number" },
          failures: { type: "number" },
          sourceTrust: { type: "string" },
          mayPromoteAutomatically: { type: "boolean" },
          requiresHumanApproval: { type: "boolean" },
          patch: { type: "object" }
        },
        required: ["name", "reason", "patch"]
      },
      riskClass: "workspace-write",
      toolsets: ["core", "files", "research"],
      progressLabel: "proposing skill patch",
      maxResultSizeChars: 4000,
      isAvailable: () => options.skillEvolutionStore !== undefined,
      run: async (input: {
        name?: string;
        reason?: string;
        confidence?: number;
        observationIds?: string[];
        successes?: number;
        failures?: number;
        sourceTrust?: SkillSourceTrust;
        mayPromoteAutomatically?: boolean;
        requiresHumanApproval?: boolean;
        patch?: SkillPatchOperation;
      }) => {
        if (options.skillEvolutionStore === undefined) {
          return errorResult("Skill evolution store is not configured.");
        }
        if (!isNonEmptyString(input.name) || !isNonEmptyString(input.reason) || input.patch === undefined) {
          return errorResult("skill.propose_patch requires name, reason, and patch");
        }
        const skill = options.registry.get(input.name);
        const proposal = await options.skillEvolutionStore.proposePatch({
          skillName: input.name,
          source: skill !== undefined && isLoadedSkill(skill) ? skill.sourceKind : undefined,
          reason: input.reason,
          confidence: input.confidence,
          observationIds: input.observationIds,
          successes: input.successes,
          failures: input.failures,
          sourceTrust: normalizeSourceTrust(input.sourceTrust),
          mayPromoteAutomatically: input.mayPromoteAutomatically,
          requiresHumanApproval: input.requiresHumanApproval,
          patch: input.patch
        });
        return {
          ok: true,
          content: `Proposed skill patch ${proposal.id} for ${proposal.skillName}.`,
          metadata: proposal
        };
      }
    },
    {
      name: "skill.list_proposals",
      description: "List proposed skill patches from the append-only evolution overlay.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          status: { type: "string" }
        }
      },
      riskClass: "read-only-local",
      toolsets: ["core", "research"],
      progressLabel: "listing skill proposals",
      maxResultSizeChars: 12_000,
      isAvailable: () => options.skillEvolutionStore !== undefined,
      run: async (input: { name?: string; status?: "proposed" | "promoted" | "rejected" }) => {
        if (options.skillEvolutionStore === undefined) {
          return errorResult("Skill evolution store is not configured.");
        }
        const proposals = await options.skillEvolutionStore.listProposals({
          skillName: input.name,
          status: input.status
        });
        return {
          ok: true,
          content: proposals.length === 0 ? "No skill patch proposals found." : JSON.stringify(proposals, null, 2),
          metadata: {
            proposals
          }
        };
      }
    },
    {
      name: "skill.review_proposals",
      description: "Review proposed skill patches with risk, trust, evidence, diff, eval, and recommended action.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          status: { type: "string" }
        }
      },
      riskClass: "read-only-local",
      toolsets: ["core", "research"],
      progressLabel: "reviewing skill proposals",
      maxResultSizeChars: 16_000,
      isAvailable: () => options.skillEvolutionStore !== undefined,
      run: async (input: { name?: string; status?: "proposed" | "promoted" | "rejected" }) => {
        if (options.skillEvolutionStore === undefined) {
          return errorResult("Skill evolution store is not configured.");
        }
        const proposals = await options.skillEvolutionStore.listProposals({
          skillName: input.name,
          status: input.status ?? "proposed"
        });
        const reviews = [];
        for (const proposal of proposals) {
          reviews.push(await reviewSkillProposal(options, proposal));
        }
        return {
          ok: true,
          content: reviews.length === 0 ? "No skill patch proposals found for review." : JSON.stringify(reviews, null, 2),
          metadata: {
            reviews
          }
        };
      }
    },
    {
      name: "skill.review_proposal",
      description: "Review one proposed skill patch with risk, trust, evidence, diff, eval, and recommended action.",
      inputSchema: {
        type: "object",
        properties: {
          proposal_id: { type: "string" },
          proposalId: { type: "string" }
        }
      },
      riskClass: "read-only-local",
      toolsets: ["core", "research"],
      progressLabel: "reviewing skill proposal",
      maxResultSizeChars: 12_000,
      isAvailable: () => options.skillEvolutionStore !== undefined,
      run: async (input: { proposal_id?: string; proposalId?: string }) => {
        if (options.skillEvolutionStore === undefined) {
          return errorResult("Skill evolution store is not configured.");
        }
        const proposalId = firstNonEmptyString(input.proposal_id, input.proposalId);
        if (!isNonEmptyString(proposalId)) {
          return errorResult("skill.review_proposal requires proposal_id");
        }
        const proposal = await options.skillEvolutionStore.findProposal(proposalId);
        if (proposal === undefined) {
          return errorResult(`Skill patch proposal not found: ${proposalId}`);
        }
        const review = await reviewSkillProposal(options, proposal);
        return {
          ok: true,
          content: JSON.stringify(review, null, 2),
          metadata: review
        };
      }
    },
    {
      name: "skill.approve_patch",
      description: "Mark a proposed skill patch as approved for later promotion.",
      inputSchema: {
        type: "object",
        properties: {
          proposal_id: { type: "string" },
          proposalId: { type: "string" },
          approvedBy: { type: "string" }
        }
      },
      riskClass: "workspace-write",
      toolsets: ["core", "research"],
      progressLabel: "approving skill patch",
      maxResultSizeChars: 4000,
      isAvailable: () => options.skillEvolutionStore !== undefined,
      run: async (input: { proposal_id?: string; proposalId?: string; approvedBy?: string }) => {
        if (options.skillEvolutionStore === undefined) {
          return errorResult("Skill evolution store is not configured.");
        }
        const proposalId = firstNonEmptyString(input.proposal_id, input.proposalId);
        if (!isNonEmptyString(proposalId)) {
          return errorResult("skill.approve_patch requires proposal_id");
        }
        const proposal = await options.skillEvolutionStore.approveProposal(proposalId, input.approvedBy ?? "user");
        if (proposal === undefined) {
          return errorResult(`Skill patch proposal not found: ${proposalId}`);
        }
        return {
          ok: true,
          content: `Approved skill patch ${proposal.id}.`,
          metadata: proposal
        };
      }
    },
    {
      name: "skill.reject_patch",
      description: "Reject a proposed skill patch without mutating SKILL.md.",
      inputSchema: {
        type: "object",
        properties: {
          proposal_id: { type: "string" },
          proposalId: { type: "string" }
        }
      },
      riskClass: "workspace-write",
      toolsets: ["core", "research"],
      progressLabel: "rejecting skill patch",
      maxResultSizeChars: 4000,
      isAvailable: () => options.skillEvolutionStore !== undefined,
      run: async (input: { proposal_id?: string; proposalId?: string }) => {
        if (options.skillEvolutionStore === undefined) {
          return errorResult("Skill evolution store is not configured.");
        }
        const proposalId = firstNonEmptyString(input.proposal_id, input.proposalId);
        if (!isNonEmptyString(proposalId)) {
          return errorResult("skill.reject_patch requires proposal_id");
        }
        const proposal = await options.skillEvolutionStore.rejectProposal(proposalId);
        if (proposal === undefined) {
          return errorResult(`Skill patch proposal not found: ${proposalId}`);
        }
        return {
          ok: true,
          content: `Rejected skill patch ${proposal.id}.`,
          metadata: proposal
        };
      }
    },
    {
      name: "skill.promote_patch",
      description: "Promote a proposed patch into a local skill after snapshot and schema/frontmatter validation.",
      inputSchema: {
        type: "object",
        properties: {
          proposal_id: { type: "string" },
          proposalId: { type: "string" }
        },
        required: ["proposal_id"]
      },
      riskClass: "workspace-write",
      toolsets: ["core", "files", "coding"],
      progressLabel: "promoting skill patch",
      maxResultSizeChars: 4000,
      isAvailable: () => options.skillEvolutionStore !== undefined,
      run: async (input: { proposal_id?: string; proposalId?: string }) => {
        if (options.skillEvolutionStore === undefined) {
          return errorResult("Skill evolution store is not configured.");
        }
        const proposalId = firstNonEmptyString(input.proposal_id, input.proposalId);
        if (!isNonEmptyString(proposalId)) {
          return errorResult("skill.promote_patch requires proposal_id");
        }
        const proposal = await options.skillEvolutionStore.findProposal(proposalId);
        if (proposal === undefined) {
          return errorResult(`Skill patch proposal not found: ${proposalId}`);
        }
        if (proposal.status !== "proposed") {
          return errorResult(`Skill patch proposal ${proposalId} is ${proposal.status}, not proposed.`);
        }
        const proposalObservations = await options.skillEvolutionStore.listObservations({
          skillName: proposal.skillName,
          ids: proposal.evidence.observations
        });
        const riskLevel = classifyPatchRisk(proposal.patch);
        const trustGate = evaluateProposalTrust(proposal, proposalObservations, riskLevel);
        if (!trustGate.ok) {
          return errorResult(trustGate.reason);
        }
        const target = await requireMutableLocalSkill(options, proposal.skillName, "promote");
        if (!isLocalSkillTarget(target)) {
          return errorResult(`Skill patch proposal ${proposalId} targets ${proposal.skillName}, but only local skills can be promoted directly.`);
        }
        const current = await readFile(target.skillPath, "utf8");
        const currentSkill = options.registry.get(proposal.skillName);
        const beforeEvalGate = currentSkill === undefined ? undefined : await runSkillEvalGate(currentSkill);
        const next = applySkillPatch(current, proposal.patch);
        const loaded = await hydrateSkillResources(parseSkillFile(target.skillPath, next, {
          sourceKind: "local",
          sourceRoot: options.localSkillsRoot
        }));
        if (loaded.name !== proposal.skillName) {
          return errorResult(`Promoted patch changed skill name from ${proposal.skillName} to ${loaded.name}`);
        }
        const evalGate = await runSkillEvalGate(loaded);
        await recordSkillEvalRuns(options.skillEvolutionStore, loaded.name, evalGate);
        if (evalGate.status === "failed") {
          return errorResult(`Skill patch proposal ${proposal.id} failed eval gate: ${evalGate.failures.join("; ")}`);
        }
        const snapshotPath = await snapshotLocalSkillTarget(options, target, proposal.skillName);
        await writeFile(target.skillPath, next, "utf8");
        options.registry.register(loaded);
        const promotion = await options.skillEvolutionStore.recordPromotion({
          proposal,
          skillName: proposal.skillName,
          snapshotPath,
          fromVersion: currentSkill?.version,
          toVersion: loaded.version,
          diffSummary: summarizePatchOperation(proposal.patch),
          riskLevel,
          evalDelta: compareEvalGates(beforeEvalGate, evalGate),
          checks: {
            evals: evalGate.status
          }
        });
        return {
          ok: true,
          content: `Promoted skill patch ${proposal.id} into ${proposal.skillName}. Evals: ${evalGate.status}; smoke validation is recorded as not-run for this minimal gate.`,
          metadata: {
            promotion,
            evalGate,
            snapshotPath,
            skill: toSkillMetadata(loaded)
          }
        };
      }
    },
    {
      name: "skill.create",
      description: "Create a local skill from full SKILL.md content or from metadata and instructions.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          content: { type: "string" },
          description: { type: "string" },
          category: { type: "string" },
          instructions: { type: "string" },
          whenToUse: { type: "array", items: { type: "string" } },
          requiredToolsets: { type: "array", items: { type: "string" } }
        },
        required: ["name"]
      },
      riskClass: "workspace-write",
      toolsets: ["core", "files", "coding"],
      progressLabel: "creating skill",
      maxResultSizeChars: 4000,
      isAvailable: () => true,
      run: async (input: {
        name?: string;
        content?: string;
        description?: string;
        category?: string;
        instructions?: string;
        whenToUse?: string[];
        requiredToolsets?: string[];
      }) => {
        if (!isNonEmptyString(input.name)) {
          return errorResult("skill.create requires name");
        }

        const skillDir = localSkillDirectory(options, input.name);
        const skillPath = join(skillDir, "SKILL.md");
        let content: string;
        try {
          content = isNonEmptyString(input.content)
            ? input.content
            : buildSkillFileContent(input);
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error));
        }

        const loaded = await hydrateSkillResources(parseSkillFile(skillPath, content, {
          sourceKind: "local",
          sourceRoot: options.localSkillsRoot
        }));
        if (loaded.name !== input.name) {
          return errorResult(`skill.create content name mismatch: expected ${input.name}, found ${loaded.name}`);
        }
        await mkdir(skillDir, { recursive: true });
        await writeFile(skillPath, content, "utf8");
        options.registry.register(loaded);
        await options.skillEvolutionStore?.recordMutation({
          skillName: loaded.name,
          source: loaded.sourceKind,
          kind: "created"
        });

        return {
          ok: true,
          content: `Created skill ${loaded.name} at ${skillPath}.`,
          metadata: toSkillMetadata(loaded)
        };
      }
    },
    {
      name: "skill.patch",
      description: "Apply a targeted text replacement to a local skill SKILL.md file.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          oldString: { type: "string" },
          newString: { type: "string" },
          replace_all: { type: "boolean" },
          replaceAll: { type: "boolean" }
        },
        required: ["name", "old_string", "new_string"]
      },
      riskClass: "workspace-write",
      toolsets: ["core", "files", "coding"],
      progressLabel: "patching skill",
      maxResultSizeChars: 4000,
      isAvailable: () => true,
      run: async (input: {
        name?: string;
        old_string?: string;
        new_string?: string;
        oldString?: string;
        newString?: string;
        replace_all?: boolean;
        replaceAll?: boolean;
      }) => {
        const oldString = firstNonEmptyString(input.old_string, input.oldString);
        const newString = firstDefinedString(input.new_string, input.newString);
        if (!isNonEmptyString(input.name) || !isNonEmptyString(oldString) || newString === undefined) {
          return errorResult("skill.patch requires name, old_string, and new_string");
        }

        const target = await requireMutableLocalSkill(options, input.name, "patch");
        if (!isLocalSkillTarget(target)) {
          return target;
        }

        const current = await readFile(target.skillPath, "utf8");
        const occurrences = countOccurrences(current, oldString);
        if (occurrences === 0) {
          return errorResult(`skill.patch could not find target text in ${target.skillPath}`);
        }
        const replaceAll = input.replace_all === true || input.replaceAll === true;
        if (occurrences > 1 && !replaceAll) {
          return errorResult(`skill.patch matched ${occurrences} occurrences. Pass replace_all=true to patch all occurrences, or use a more specific old_string.`);
        }

        const next = replaceAll
          ? current.split(oldString).join(newString)
          : current.replace(oldString, newString);
        const validation = await validateSkillContentMutation({
          options,
          current: target.skill,
          skillPath: target.skillPath,
          next,
          expectedName: input.name,
          action: "patch"
        });
        if (!("sourcePath" in validation)) {
          return validation;
        }
        const loaded = validation;
        const snapshotPath = await snapshotLocalSkillTarget(options, target, input.name);
        await writeFile(target.skillPath, next, "utf8");
        options.registry.register(loaded);
        await options.skillEvolutionStore?.recordMutation({
          skillName: loaded.name,
          source: loaded.sourceKind,
          kind: "patched"
        });

        return {
          ok: true,
          content: `Patched skill ${loaded.name} at ${target.skillPath}.`,
          metadata: {
            ...toSkillMetadata(loaded),
            snapshotPath,
            replaced: occurrences
          }
        };
      }
    },
    {
      name: "skill.edit",
      description: "Replace a local skill SKILL.md file with full content.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          content: { type: "string" }
        },
        required: ["name", "content"]
      },
      riskClass: "workspace-write",
      toolsets: ["core", "files", "coding"],
      progressLabel: "editing skill",
      maxResultSizeChars: 4000,
      isAvailable: () => true,
      run: async (input: { name?: string; content?: string }) => {
        if (!isNonEmptyString(input.name) || !isNonEmptyString(input.content)) {
          return errorResult("skill.edit requires name and content");
        }

        const target = await requireMutableLocalSkill(options, input.name, "edit");
        if (!isLocalSkillTarget(target)) {
          return target;
        }

        const validation = await validateSkillContentMutation({
          options,
          current: target.skill,
          skillPath: target.skillPath,
          next: input.content,
          expectedName: input.name,
          action: "edit"
        });
        if (!("sourcePath" in validation)) {
          return validation;
        }
        const loaded = validation;
        const snapshotPath = await snapshotLocalSkillTarget(options, target, input.name);
        await writeFile(target.skillPath, input.content, "utf8");
        options.registry.register(loaded);
        await options.skillEvolutionStore?.recordMutation({
          skillName: loaded.name,
          source: loaded.sourceKind,
          kind: "edited"
        });

        return {
          ok: true,
          content: `Edited skill ${loaded.name} at ${target.skillPath}.`,
          metadata: {
            ...toSkillMetadata(loaded),
            snapshotPath
          }
        };
      }
    },
    {
      name: "skill.delete",
      description: "Archive a local skill directory and remove it from the active registry.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" }
        },
        required: ["name"]
      },
      riskClass: "destructive-local",
      toolsets: ["core", "files", "coding"],
      progressLabel: "deleting skill",
      maxResultSizeChars: 4000,
      isAvailable: () => true,
      run: async (input: { name?: string }) => {
        if (!isNonEmptyString(input.name)) {
          return errorResult("skill.delete requires name");
        }

        const target = await requireMutableLocalSkill(options, input.name, "delete");
        if (!isLocalSkillTarget(target)) {
          return target;
        }

        const snapshotPath = await snapshotLocalSkillTarget(options, target, input.name);
        const archivePath = await archiveLocalSkillTarget(options, target, input.name);
        options.registry.unregister(input.name);
        await options.skillEvolutionStore?.recordMutation({
          skillName: input.name,
          source: "local",
          kind: "deleted"
        });

        return {
          ok: true,
          content: `Archived skill ${input.name} from ${target.skillDir}.`,
          metadata: {
            name: input.name,
            archived: true,
            path: target.skillDir,
            archivePath,
            snapshotPath
          }
        };
      }
    },
    {
      name: "skill.rollback",
      description: "Restore a local skill from a versioned snapshot created before an edit, patch, or delete.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          snapshot_path: { type: "string" },
          snapshotPath: { type: "string" }
        },
        required: ["name"]
      },
      riskClass: "workspace-write",
      toolsets: ["core", "files", "coding"],
      progressLabel: "rolling back skill",
      maxResultSizeChars: 4000,
      isAvailable: () => true,
      run: async (input: { name?: string; snapshot_path?: string; snapshotPath?: string }) => {
        if (!isNonEmptyString(input.name)) {
          return errorResult("skill.rollback requires name");
        }
        const snapshot = await resolveSkillSnapshotPath(options, input.name, firstNonEmptyString(input.snapshot_path, input.snapshotPath));
        if (!("path" in snapshot)) {
          return snapshot;
        }
        const skillDir = localSkillDirectory(options, input.name);
        const current = options.registry.get(input.name);
        let preRollbackSnapshot: string | undefined;
        if (current !== undefined && isLoadedSkill(current) && current.sourceKind === "local") {
          preRollbackSnapshot = await snapshotLocalSkillTarget(options, {
            ok: true,
            skillDir: dirname(current.sourcePath),
            skillPath: current.sourcePath,
            skill: current
          }, input.name);
        }

        await rm(skillDir, { recursive: true, force: true });
        await mkdir(dirname(skillDir), { recursive: true });
        await cp(snapshot.path, skillDir, { recursive: true });
        const loaded = await reloadLocalSkill(options, join(skillDir, "SKILL.md"));
        await options.skillEvolutionStore?.recordMutation({
          skillName: loaded.name,
          source: loaded.sourceKind,
          kind: "rolled-back"
        });

        return {
          ok: true,
          content: `Rolled back skill ${loaded.name} from ${snapshot.path}.`,
          metadata: {
            ...toSkillMetadata(loaded),
            snapshotPath: snapshot.path,
            preRollbackSnapshot
          }
        };
      }
    },
    {
      name: "skill.reset",
      description: "Reset a bundled-derived local skill to its bundled baseline, or rebaseline the current local copy.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          mode: { type: "string", enum: ["restore", "rebaseline"] }
        },
        required: ["name"]
      },
      riskClass: "workspace-write",
      toolsets: ["core", "files", "coding"],
      progressLabel: "resetting bundled skill",
      maxResultSizeChars: 4000,
      isAvailable: () => options.bundledSkillsRoot !== undefined,
      run: async (input: { name?: string; mode?: "restore" | "rebaseline" }) => {
        if (!isNonEmptyString(input.name)) {
          return errorResult("skill.reset requires name");
        }
        if (options.bundledSkillsRoot === undefined) {
          return errorResult("skill.reset requires a bundled skills root");
        }
        const mode = input.mode ?? "restore";
        const reset = await resetBundledSkill({
          name: input.name,
          mode,
          bundledSkillsDir: options.bundledSkillsRoot,
          localSkillsRoot: options.localSkillsRoot
        });
        if (!reset.ok) {
          return errorResult(reset.message);
        }

        const skillPath = join(options.localSkillsRoot, reset.localPath ?? slugifySkillName(input.name), "SKILL.md");
        const loaded = await reloadLocalSkill(options, skillPath);
        await options.skillEvolutionStore?.recordMutation({
          skillName: loaded.name,
          source: loaded.sourceKind,
          provenanceKind: loaded.provenance?.kind,
          kind: "rolled-back"
        });

        return {
          ok: true,
          content: reset.message,
          metadata: {
            ...toSkillMetadata(loaded),
            mode,
            bundledPath: reset.bundledPath,
            localPath: reset.localPath
          }
        };
      }
    },
    {
      name: "skill.write_file",
      description: "Write a supporting file inside a local skill directory.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          file_path: { type: "string" },
          file_content: { type: "string" },
          filePath: { type: "string" },
          fileContent: { type: "string" }
        },
        required: ["name", "file_path", "file_content"]
      },
      riskClass: "workspace-write",
      toolsets: ["core", "files", "coding"],
      progressLabel: "writing skill file",
      maxResultSizeChars: 4000,
      isAvailable: () => true,
      run: async (input: {
        name?: string;
        file_path?: string;
        file_content?: string;
        filePath?: string;
        fileContent?: string;
      }) => {
        const filePath = firstNonEmptyString(input.file_path, input.filePath);
        const fileContent = firstDefinedString(input.file_content, input.fileContent);
        if (!isNonEmptyString(input.name) || !isNonEmptyString(filePath) || fileContent === undefined) {
          return errorResult("skill.write_file requires name, file_path, and file_content");
        }

        const target = await requireMutableLocalSkill(options, input.name, "write-file");
        if (!isLocalSkillTarget(target)) {
          return target;
        }

        const supportFile = await resolveSkillSupportPath(target.skillDir, filePath);
        if (!isSkillSupportTarget(supportFile)) {
          return supportFile;
        }

        const snapshotPath = await snapshotLocalSkillTarget(options, target, input.name);
        await mkdir(dirname(supportFile.path), { recursive: true });
        await writeFile(supportFile.path, fileContent, "utf8");
        await options.skillEvolutionStore?.recordMutation({
          skillName: input.name,
          source: "local",
          kind: "edited"
        });

        return {
          ok: true,
          content: `Wrote ${supportFile.relativePath} for skill ${input.name}.`,
          metadata: {
            name: input.name,
            path: supportFile.relativePath,
            bytes: Buffer.byteLength(fileContent),
            snapshotPath
          }
        };
      }
    },
    {
      name: "skill.remove_file",
      description: "Remove a supporting file from a local skill directory.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          file_path: { type: "string" },
          filePath: { type: "string" }
        },
        required: ["name", "file_path"]
      },
      riskClass: "destructive-local",
      toolsets: ["core", "files", "coding"],
      progressLabel: "removing skill file",
      maxResultSizeChars: 4000,
      isAvailable: () => true,
      run: async (input: { name?: string; file_path?: string; filePath?: string }) => {
        const filePath = firstNonEmptyString(input.file_path, input.filePath);
        if (!isNonEmptyString(input.name) || !isNonEmptyString(filePath)) {
          return errorResult("skill.remove_file requires name and file_path");
        }

        const target = await requireMutableLocalSkill(options, input.name, "remove-file");
        if (!isLocalSkillTarget(target)) {
          return target;
        }

        const supportFile = await resolveSkillSupportPath(target.skillDir, filePath);
        if (!isSkillSupportTarget(supportFile)) {
          return supportFile;
        }

        const snapshotPath = await snapshotLocalSkillTarget(options, target, input.name);
        await rm(supportFile.path, { force: true });
        await options.skillEvolutionStore?.recordMutation({
          skillName: input.name,
          source: "local",
          kind: "edited"
        });

        return {
          ok: true,
          content: `Removed ${supportFile.relativePath} from skill ${input.name}.`,
          metadata: {
            name: input.name,
            path: supportFile.relativePath,
            removed: true,
            snapshotPath
          }
        };
      }
    },
    {
      name: "skill.import",
      description: "Import skills from an existing directory by copying them into the local writable skills root.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" }
        },
        required: ["path"]
      },
      riskClass: "workspace-write",
      toolsets: ["core", "files", "coding"],
      progressLabel: "importing skills",
      maxResultSizeChars: 8000,
      isAvailable: () => true,
      run: async (input: { path?: string }) => {
        if (!isNonEmptyString(input.path)) {
          return errorResult("skill.import requires path");
        }

        const root = resolve(input.path);
        const loaded = await loadSkillsFromDirectory(root, {
          sourceKind: "external",
          sourceRoot: root
        });

        if (loaded.errors.length > 0) {
          return {
            ok: false,
            content: [
              `Import from ${root} found ${loaded.errors.length} error(s); no skills were copied.`,
              ...loaded.errors.map((error) => `Error ${error.path}: ${error.message}`)
            ].join("\n"),
            metadata: {
              errors: loaded.errors
            }
          };
        }

        const preflight = await planLocalSkillImport(options, loaded.skills);
        if (!("skills" in preflight)) {
          return preflight;
        }

        const imported: LoadedSkill[] = [];
        for (const item of preflight.skills) {
          await cp(dirname(item.skill.sourcePath), item.targetDir, { recursive: true });
          imported.push(await reloadLocalSkill(options, join(item.targetDir, "SKILL.md")));
        }

        for (const skill of imported) {
          await options.skillEvolutionStore?.recordMutation({
            skillName: skill.name,
            source: skill.sourceKind,
            provenanceKind: skill.provenance?.kind,
            kind: "created"
          });
        }

        return {
          ok: true,
          content: [
            `Imported ${imported.length} skill(s) from ${root} into ${options.localSkillsRoot}.`,
            "Imported skills are registered as local working copies; the source directory was not modified."
          ].join("\n"),
          metadata: {
            imported: imported.map(toSkillMetadata),
            sourceRoot: root,
            localSkillsRoot: options.localSkillsRoot
          }
        };
      }
    },
    {
      name: "skill.export",
      description: "Export a loaded skill to a destination directory as SKILL.md.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          destination: { type: "string" }
        },
        required: ["name", "destination"]
      },
      riskClass: "workspace-write",
      toolsets: ["core", "files", "coding"],
      progressLabel: "exporting skill",
      maxResultSizeChars: 4000,
      isAvailable: () => true,
      run: async (input: { name?: string; destination?: string }) => {
        const skill = getSkill(options.registry, input.name);
        if (!skill.ok) {
          return skill;
        }
        const foundSkill = skill.skill;

        if (!isNonEmptyString(input.destination)) {
          return errorResult("skill.export requires destination");
        }

        const destination = resolve(input.destination, slugifySkillName(foundSkill.name), "SKILL.md");
        await mkdir(dirname(destination), { recursive: true });

        if ("sourcePath" in foundSkill) {
          await writeFile(destination, await readFile(foundSkill.sourcePath, "utf8"), "utf8");
        } else {
          await writeFile(destination, renderSkillFile(foundSkill, foundSkill.description), "utf8");
        }

        return {
          ok: true,
          content: `Exported ${foundSkill.name} to ${destination}.`,
          metadata: {
            destination,
            skill: toSkillMetadata(foundSkill)
          }
        };
      }
    }
  ];
}

type GetSkillResult =
  | { ok: true; content: ""; skill: LoadedSkill | SkillDefinition }
  | { ok: false; content: string };

function getSkill(registry: SkillRegistry, name: string | undefined): GetSkillResult {
  if (!isNonEmptyString(name)) {
    return skillError("skill name is required");
  }

  const skill = registry.get(name);

  if (skill === undefined) {
    return skillError(`Skill not found: ${name}`);
  }

  return {
    ok: true,
    content: "",
    skill
  };
}

function toSkillMetadata(skill: LoadedSkill | SkillDefinition): Record<string, unknown> {
  return {
    name: skill.name,
    description: skill.description,
    version: skill.version,
    category: skill.category ?? "general",
    intentLabels: skill.intentLabels,
    triggerPatterns: skill.triggerPatterns,
    negativePatterns: skill.negativePatterns,
    whenToUse: skill.whenToUse,
    requiredToolsets: skill.requiredToolsets,
    optionalToolsets: skill.optionalToolsets,
    requiredEnvironmentVariables: skill.requiredEnvironmentVariables,
    requiredCredentialFiles: skill.requiredCredentialFiles,
    configFields: skill.configFields,
    visibility: skill.visibility,
    workflow: skill.workflow,
    permissionExpectations: skill.permissionExpectations,
    examples: skill.examples,
    evaluations: skill.evaluations,
    platforms: skill.platforms,
    references: skill.references,
    resources: "resources" in skill ? skill.resources : undefined,
    metadata: skill.metadata,
    sourcePath: "sourcePath" in skill ? skill.sourcePath : undefined,
    sourceKind: "sourceKind" in skill ? skill.sourceKind : undefined,
    sourceRoot: "sourceRoot" in skill ? skill.sourceRoot : undefined
  };
}

function defaultSkillDefinition(input: {
  name: string;
  description: string;
  category?: string;
  whenToUse?: string[];
  requiredToolsets?: string[];
}): SkillDefinition {
  return {
    name: input.name,
    description: input.description,
    version: "0.1.0",
    category: input.category,
    intentLabels: [],
    triggerPatterns: [],
    negativePatterns: [],
    whenToUse: input.whenToUse ?? [input.description],
    requiredToolsets: input.requiredToolsets ?? ["core"],
    optionalToolsets: [],
    workflow: [
      {
        id: "run",
        description: input.description,
        toolsets: input.requiredToolsets ?? ["core"]
      }
    ],
    permissionExpectations: ["auto-read"],
    examples: [],
    evaluations: []
  };
}

function renderSkillFile(definition: SkillDefinition, instructions: string): string {
  return `---\n${renderJsonFrontmatter(definition)}\n---\n${instructions.trim()}\n`;
}

export function buildSkillFileContent(input: {
  name?: string;
  description?: string;
  category?: string;
  instructions?: string;
  whenToUse?: string[];
  requiredToolsets?: string[];
  metadata?: Record<string, unknown>;
  evaluations?: SkillEvaluation[];
}): string {
  if (!isNonEmptyString(input.name) || !isNonEmptyString(input.description) || !isNonEmptyString(input.instructions)) {
    throw new Error("skill.create requires either content or description plus instructions");
  }

  const definition = defaultSkillDefinition({
    name: input.name,
    description: input.description,
    category: input.category,
    whenToUse: input.whenToUse,
    requiredToolsets: input.requiredToolsets
  });
  if (input.metadata !== undefined) {
    definition.metadata = input.metadata;
  }
  if (input.evaluations !== undefined) {
    definition.evaluations = input.evaluations;
  }
  return renderSkillFile(definition, input.instructions);
}

export function slugifySkillName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, "-").replace(/^-|-$/g, "") || basename(value);
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  return values.find((value) => isNonEmptyString(value));
}

function firstDefinedString(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArrayOrEmpty(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isNonEmptyString) : [];
}

function normalizeSourceTrust(value: unknown): SkillSourceTrust | undefined {
  return isSourceTrust(value) ? value : undefined;
}

function isSourceTrust(value: unknown): value is SkillSourceTrust {
  return value === "untrusted_web" ||
    value === "untrusted_document" ||
    value === "user_direct" ||
    value === "tool_error" ||
    value === "runtime_internal" ||
    value === "developer";
}

function errorResult(content: string): ToolResult {
  return {
    ok: false,
    content
  };
}

function skillError(content: string): GetSkillResult {
  return {
    ok: false,
    content
  };
}

function isLoadedSkill(skill: LoadedSkill | SkillDefinition): skill is LoadedSkill {
  return "sourcePath" in skill && "instructions" in skill;
}

type SkillEvalGateResult = {
  status: "passed" | "failed" | "not-run";
  caseCount: number;
  score: number;
  threshold: number;
  cases: Array<{
    id: string;
    score: number;
    passed: boolean;
    details: Record<string, boolean>;
    threshold: number;
  }>;
  failures: string[];
  checkedFiles: string[];
};

type SkillEvalCase = SkillEvaluation & {
  id?: string;
  prompt?: string;
  availableToolsets?: string[];
  passThreshold?: number;
  scoring?: Record<string, number>;
  shouldNotUseToolsets?: string[];
  expected?: {
    selectedSkill?: string;
    workflowStep?: string;
    mustAttempt?: string[];
    mustUseOneOf?: string[];
    mustNotUse?: string[];
    mustEndState?: string;
    skillVisible?: boolean;
    degraded?: boolean;
  };
};

async function runSkillEvalGate(skill: LoadedSkill | SkillDefinition): Promise<SkillEvalGateResult> {
  const loadedCases = await loadSkillEvalCases(skill);
  const cases: SkillEvalCase[] = [
    ...skill.evaluations.map((evaluation, index) => ({
      ...evaluation,
      id: `frontmatter-${index + 1}`
    })),
    ...loadedCases.cases
  ];
  if (cases.length === 0) {
    return {
      status: "not-run",
      caseCount: 0,
      score: 0,
      threshold: 1,
      cases: [],
      failures: [],
      checkedFiles: loadedCases.checkedFiles
    };
  }

  const availableToolsets = new Set([
    ...skill.requiredToolsets,
    ...(skill.optionalToolsets ?? []),
    ...skill.workflow.flatMap((step) => step.toolsets ?? [])
  ]);
  const declaredTools = new Set(skill.workflow.flatMap((step) => [
    step.preferredTool,
    ...(step.toolCandidates ?? [])
  ].filter(isNonEmptyString)));
  const failures: string[] = [];
  const caseResults: SkillEvalGateResult["cases"] = [];

  for (const [index, evaluation] of cases.entries()) {
    const label = evaluation.id ?? evaluation.input ?? evaluation.prompt ?? `case-${index + 1}`;
    const details: Record<string, boolean> = {};
    for (const toolset of evaluation.shouldUseToolsets ?? []) {
      details[`uses_toolset:${toolset}`] = availableToolsets.has(toolset);
      if (!details[`uses_toolset:${toolset}`]) {
        failures.push(`${label}: expected toolset ${toolset} is not declared by the skill workflow`);
      }
    }
    for (const toolset of evaluation.shouldNotUseToolsets ?? []) {
      details[`avoids_toolset:${toolset}`] = !availableToolsets.has(toolset);
      if (!details[`avoids_toolset:${toolset}`]) {
        failures.push(`${label}: forbidden toolset ${toolset} is still declared by the skill workflow`);
      }
    }
    if (evaluation.shouldNotAskUserFirst === true) {
      details.shouldNotAskUserFirst = !skill.permissionExpectations.some((expectation) => expectation.startsWith("ask-before"));
    }
    if (details.shouldNotAskUserFirst === false) {
      failures.push(`${label}: shouldNotAskUserFirst conflicts with ask-before permission expectations`);
    }
    if (evaluation.expected?.selectedSkill !== undefined) {
      details.selectedSkill = evaluation.expected.selectedSkill === skill.name;
    }
    if (details.selectedSkill === false) {
      failures.push(`${label}: expected selectedSkill ${evaluation.expected?.selectedSkill}, got ${skill.name}`);
    }
    if (evaluation.expected?.workflowStep !== undefined) {
      details.workflowStep = skill.workflow.some((step) => step.id === evaluation.expected?.workflowStep);
    }
    if (details.workflowStep === false) {
      failures.push(`${label}: expected workflow step ${evaluation.expected?.workflowStep} is not declared`);
    }
    for (const tool of evaluation.expected?.mustAttempt ?? []) {
      details[`must_attempt:${tool}`] = declaredTools.has(tool);
      if (!details[`must_attempt:${tool}`]) {
        failures.push(`${label}: expected tool candidate ${tool} is not declared by the workflow`);
      }
    }
    if ((evaluation.expected?.mustUseOneOf ?? []).length > 0) {
      details.mustUseOneOf = evaluation.expected!.mustUseOneOf!.some((tool) => declaredTools.has(tool));
      if (!details.mustUseOneOf) {
        failures.push(`${label}: none of expected tool candidates are declared: ${evaluation.expected!.mustUseOneOf!.join(", ")}`);
      }
    }
    for (const tool of evaluation.expected?.mustNotUse ?? []) {
      details[`must_not_use:${tool}`] = !declaredTools.has(tool);
      if (!details[`must_not_use:${tool}`]) {
        failures.push(`${label}: forbidden tool candidate ${tool} is declared by the workflow`);
      }
    }
    if (evaluation.expected?.skillVisible === false) {
      failures.push(`${label}: promotion evals cannot currently assert skillVisible=false`);
      details.skillVisible = false;
    } else if (evaluation.expected?.skillVisible === true) {
      details.skillVisible = true;
    }
    if (evaluation.expected?.degraded !== undefined) {
      details.degraded = true;
    }
    if (evaluation.expected?.mustEndState !== undefined) {
      details.finalBehavior = true;
    }
    const threshold = clampEvalScore(evaluation.passThreshold ?? 1);
    const score = scoreEvalDetails(details, evaluation.scoring);
    const passed = score >= threshold;
    if (!passed) {
      failures.push(`${label}: score ${score.toFixed(2)} below threshold ${threshold.toFixed(2)}`);
    }
    caseResults.push({
      id: label,
      score,
      passed,
      details,
      threshold
    });
  }

  const score = caseResults.length === 0
    ? 0
    : caseResults.reduce((sum, result) => sum + result.score, 0) / caseResults.length;
  const threshold = caseResults.length === 0
    ? 1
    : Math.min(...caseResults.map((result) => result.threshold));
  return {
    status: failures.length === 0 ? "passed" : "failed",
    caseCount: cases.length,
    score,
    threshold,
    cases: caseResults,
    failures,
    checkedFiles: loadedCases.checkedFiles
  };
}

async function loadSkillEvalCases(skill: LoadedSkill | SkillDefinition): Promise<{ cases: SkillEvalCase[]; checkedFiles: string[] }> {
  if (!isLoadedSkill(skill)) {
    return { cases: [], checkedFiles: [] };
  }
  const evalRoot = join(dirname(skill.sourcePath), "evals");
  const entries = await readdir(evalRoot, { withFileTypes: true }).catch(() => []);
  const cases: SkillEvalCase[] = [];
  const checkedFiles: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || (!entry.name.endsWith(".jsonl") && !entry.name.endsWith(".json"))) {
      continue;
    }
    const path = join(evalRoot, entry.name);
    checkedFiles.push(path);
    const raw = await readFile(path, "utf8");
    if (entry.name.endsWith(".jsonl")) {
      for (const line of raw.split(/\r?\n/u)) {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          cases.push(normalizeEvalCase(JSON.parse(trimmed)));
        }
      }
      continue;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      cases.push(...parsed.map(normalizeEvalCase));
    } else {
      cases.push(normalizeEvalCase(parsed));
    }
  }
  return { cases, checkedFiles };
}

function normalizeEvalCase(value: unknown): SkillEvalCase {
  if (!isRecord(value)) {
    throw new Error("Skill eval case must be an object.");
  }
  const input = firstNonEmptyString(value.input, value.prompt) ?? "";
  return {
    id: firstNonEmptyString(value.id),
    input,
    prompt: firstNonEmptyString(value.prompt),
    availableToolsets: stringArrayOrEmpty(value.availableToolsets ?? value.available_toolsets),
    passThreshold: typeof value.passThreshold === "number"
      ? value.passThreshold
      : typeof value.pass_threshold === "number"
        ? value.pass_threshold
        : undefined,
    scoring: isRecord(value.scoring) ? numericRecord(value.scoring) : undefined,
    shouldUseToolsets: stringArrayOrEmpty(value.shouldUseToolsets ?? value.should_use_toolsets),
    shouldNotUseToolsets: stringArrayOrEmpty(value.shouldNotUseToolsets ?? value.should_not_use_toolsets),
    shouldNotAskUserFirst: value.shouldNotAskUserFirst === true || value.should_not_ask_user_first === true,
    expectedOutcome: firstNonEmptyString(value.expectedOutcome, value.expected_outcome),
    expected: isRecord(value.expected)
      ? {
          selectedSkill: firstNonEmptyString(value.expected.selectedSkill ?? value.expected.selected_skill),
          workflowStep: firstNonEmptyString(value.expected.workflowStep ?? value.expected.workflow_step),
          mustAttempt: stringArrayOrEmpty(value.expected.mustAttempt ?? value.expected.must_attempt),
          mustUseOneOf: stringArrayOrEmpty(value.expected.mustUseOneOf ?? value.expected.must_use_one_of),
          mustNotUse: stringArrayOrEmpty(value.expected.mustNotUse ?? value.expected.must_not_use),
          mustEndState: firstNonEmptyString(value.expected.mustEndState ?? value.expected.must_end_state),
          skillVisible: typeof value.expected.skillVisible === "boolean" ? value.expected.skillVisible : undefined,
          degraded: typeof value.expected.degraded === "boolean" ? value.expected.degraded : undefined
        }
      : undefined
  };
}

function evaluateProposalTrust(
  proposal: SkillPatchProposal,
  observations: SkillObservationRecord[],
  riskLevel: SkillPatchRiskLevel
): { ok: true } | { ok: false; reason: string } {
  if (proposal.requiresHumanApproval && proposal.approvedAt === undefined) {
    return {
      ok: false,
      reason: "Skill patch proposal requires explicit approval before promotion."
    };
  }
  if (riskLevel !== "low" && proposal.approvedAt === undefined) {
    return {
      ok: false,
      reason: `Skill patch proposal is ${riskLevel}-risk and requires explicit approval before promotion.`
    };
  }
  if (isUntrustedSource(proposal.sourceTrust) && proposal.approvedAt === undefined) {
    return {
      ok: false,
      reason: "Skill patch proposal is derived from untrusted content and requires review before promotion."
    };
  }
  if (observations.length > 0 && observations.every((observation) => isUntrustedSource(observation.sourceTrust))) {
    return {
      ok: false,
      reason: "Skill patch proposal only cites untrusted observations and requires review before promotion."
    };
  }
  return { ok: true };
}

function isUntrustedSource(sourceTrust: SkillSourceTrust): boolean {
  return sourceTrust === "untrusted_web" || sourceTrust === "untrusted_document";
}

function summarizePatchOperation(patch: SkillPatchOperation): string {
  if (patch.type === "text_patch") {
    return patch.replaceAll === true ? "Applied text replacement to all matching occurrences." : "Applied one exact text replacement.";
  }
  return `${patch.operation ?? "add"} JSON frontmatter path ${patch.path}.`;
}

function classifyPatchRisk(patch: SkillPatchOperation): SkillPatchRiskLevel {
  const serialized = JSON.stringify(patch).toLowerCase();
  if (/\b(required_credential_files|requiredcredentialfiles|required_environment_variables|requiredenvironmentvariables|permission_expectations|permissionexpectations|terminal\.run|execute_code|browser\.|web\.|external|credential|secret|token|api[_-]?key)\b/u.test(serialized)) {
    return "high";
  }
  if (patch.type === "json_frontmatter_patch" && /\/(workflow|triggerpatterns|trigger_patterns|intentlabels|intent_labels|negativepatterns|negative_patterns|requiredtoolsets|required_toolsets|optionaltoolsets|optional_toolsets)\b/u.test(patch.path.toLowerCase())) {
    return "medium";
  }
  return "low";
}

async function reviewSkillProposal(
  options: SkillToolsOptions,
  proposal: SkillPatchProposal
): Promise<Record<string, unknown>> {
  const observations = await options.skillEvolutionStore?.listObservations({
    skillName: proposal.skillName,
    ids: proposal.evidence.observations
  }) ?? [];
  const riskLevel = classifyPatchRisk(proposal.patch);
  const skill = options.registry.get(proposal.skillName);
  const evalGate = skill === undefined ? undefined : await runSkillEvalGate(skill);
  const trustGate = evaluateProposalTrust(proposal, observations, riskLevel);
  const recommendedAction = proposal.status !== "proposed"
    ? "none"
    : !trustGate.ok
      ? "review"
      : evalGate?.status === "failed"
        ? "reject"
        : riskLevel === "low"
          ? "promote"
          : "approve";
  return {
    proposalId: proposal.id,
    skillName: proposal.skillName,
    status: proposal.status,
    sourceTrust: proposal.sourceTrust,
    reason: proposal.reason,
    evidenceCount: proposal.evidence.observations.length,
    riskLevel,
    affectedFields: affectedFieldsForPatch(proposal.patch),
    diffSummary: summarizePatchOperation(proposal.patch),
    evalResult: evalGate === undefined
      ? undefined
      : {
          status: evalGate.status,
          score: evalGate.score,
          threshold: evalGate.threshold,
          failures: evalGate.failures
        },
    recommendedAction,
    blockedReason: trustGate.ok ? undefined : trustGate.reason
  };
}

function affectedFieldsForPatch(patch: SkillPatchOperation): string[] {
  if (patch.type === "text_patch") {
    return ["body"];
  }
  const field = patch.path.split("/").filter((part) => part.length > 0)[0];
  return field === undefined ? ["frontmatter"] : [field.replace(/~1/gu, "/").replace(/~0/gu, "~")];
}

async function recordSkillEvalRuns(
  store: SkillEvolutionStore,
  skillName: string,
  result: SkillEvalGateResult
): Promise<SkillEvalRunRecord[]> {
  const records: SkillEvalRunRecord[] = [];
  for (const item of result.cases) {
    records.push(await store.recordEvalRun({
      skillName,
      evalId: item.id,
      score: item.score,
      passed: item.passed,
      details: item.details,
      threshold: item.threshold
    }));
  }
  return records;
}

function compareEvalGates(
  before: SkillEvalGateResult | undefined,
  after: SkillEvalGateResult
) {
  const beforeScore = before?.status === "not-run" ? undefined : before?.score;
  const afterScore = after.status === "not-run" ? 0 : after.score;
  const beforeCases = new Map((before?.cases ?? []).map((item) => [item.id, item]));
  const newlyPassingCases: string[] = [];
  const newlyFailingCases: string[] = [];
  for (const item of after.cases) {
    const previous = beforeCases.get(item.id);
    if (previous !== undefined && !previous.passed && item.passed) {
      newlyPassingCases.push(item.id);
    }
    if (previous !== undefined && previous.passed && !item.passed) {
      newlyFailingCases.push(item.id);
    }
  }
  return {
    beforeScore,
    afterScore,
    delta: beforeScore === undefined ? undefined : afterScore - beforeScore,
    failedCases: after.cases.filter((item) => !item.passed).map((item) => item.id),
    newlyPassingCases,
    newlyFailingCases
  };
}

function scoreEvalDetails(details: Record<string, boolean>, scoring: Record<string, number> | undefined): number {
  const entries = Object.entries(details);
  if (entries.length === 0) {
    return 1;
  }
  if (scoring === undefined || Object.keys(scoring).length === 0) {
    return entries.filter(([, passed]) => passed).length / entries.length;
  }
  let total = 0;
  let earned = 0;
  for (const [key, passed] of entries) {
    const weight = scoring[key] ?? scoring[key.split(":")[0]!] ?? 0;
    total += weight;
    if (passed) {
      earned += weight;
    }
  }
  if (total <= 0) {
    return entries.filter(([, passed]) => passed).length / entries.length;
  }
  return clampEvalScore(earned / total);
}

function numericRecord(value: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
}

function clampEvalScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function localSkillDirectory(options: SkillToolsOptions, name: string): string {
  return join(options.localSkillsRoot, slugifySkillName(name));
}

async function requireMutableLocalSkill(
  options: SkillToolsOptions,
  name: string,
  action: "patch" | "edit" | "delete" | "write-file" | "remove-file" | "promote"
): Promise<{ ok: true; skillDir: string; skillPath: string; skill: LoadedSkill } | ToolResult> {
  const existing = options.registry.get(name);
  if (existing !== undefined) {
    if (!isLoadedSkill(existing)) {
      return errorResult(`Skill ${name} is not a file-backed skill and cannot be modified here.`);
    }
    const mutable = await assertSkillMutable({
      skill: existing,
      action,
      store: options.skillEvolutionStore
    });
    if (!mutable.ok) {
      return errorResult(mutable.reason);
    }
    if (existing.sourceKind !== "local") {
      return await createLocalWorkingCopy(options, existing);
    }

    return {
      ok: true,
      skillDir: dirname(existing.sourcePath),
      skillPath: existing.sourcePath,
      skill: existing
    };
  }

  return errorResult(`Local skill not found: ${name}`);
}

function isLocalSkillTarget(
  value: { ok: true; skillDir: string; skillPath: string; skill: LoadedSkill } | ToolResult
): value is { ok: true; skillDir: string; skillPath: string; skill: LoadedSkill } {
  return value.ok === true && "skillDir" in value && "skillPath" in value;
}

async function reloadLocalSkill(options: SkillToolsOptions, skillPath: string): Promise<LoadedSkill> {
  const loaded = await hydrateSkillResources(parseSkillFile(skillPath, await readFile(skillPath, "utf8"), {
    sourceKind: "local",
    sourceRoot: options.localSkillsRoot
  }));
  options.registry.register(loaded);
  return loaded;
}

async function validateSkillContentMutation(input: {
  options: SkillToolsOptions;
  current: LoadedSkill;
  skillPath: string;
  next: string;
  expectedName: string;
  action: "patch" | "edit";
}): Promise<LoadedSkill | ToolResult> {
  let loaded: LoadedSkill;
  try {
    loaded = await hydrateSkillResources(parseSkillFile(input.skillPath, input.next, {
      sourceKind: "local",
      sourceRoot: input.options.localSkillsRoot
    }));
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }

  if (loaded.name !== input.expectedName) {
    return errorResult(`skill.${input.action} content name mismatch: expected ${input.expectedName}, found ${loaded.name}`);
  }

  const authority = await assertSkillContentMutationAllowed({
    current: input.current,
    next: loaded,
    action: input.action,
    store: input.options.skillEvolutionStore
  });
  if (!authority.ok) {
    return errorResult(authority.reason);
  }

  const evalGate = await runSkillEvalGate(loaded);
  if (evalGate.status === "failed") {
    if (input.options.skillEvolutionStore !== undefined) {
      await recordSkillEvalRuns(input.options.skillEvolutionStore, loaded.name, evalGate);
    }
    return errorResult(`skill.${input.action} failed eval gate: ${evalGate.failures.join("; ")}`);
  }
  if (evalGate.status === "passed" && input.options.skillEvolutionStore !== undefined) {
    await recordSkillEvalRuns(input.options.skillEvolutionStore, loaded.name, evalGate);
  }

  return loaded;
}

async function createLocalWorkingCopy(
  options: SkillToolsOptions,
  skill: LoadedSkill
): Promise<{ ok: true; skillDir: string; skillPath: string; skill: LoadedSkill } | ToolResult> {
  await mkdir(options.localSkillsRoot, { recursive: true });
  const contained = await ensureContainedDirectory(options.localSkillsRoot, slugifySkillName(skill.name));
  if (!contained.ok) {
    return errorResult(contained.reason);
  }
  const skillDir = contained.path;

  await rm(skillDir, { recursive: true, force: true });
  await mkdir(dirname(skillDir), { recursive: true });
  await cp(dirname(skill.sourcePath), skillDir, { recursive: true });
  const localSkillPath = join(skillDir, "SKILL.md");
  const loaded = await reloadLocalSkill(options, localSkillPath);

  await options.skillEvolutionStore?.recordMutation({
    skillName: loaded.name,
    source: loaded.sourceKind,
    kind: "created"
  });

  return {
    ok: true,
    skillDir,
    skillPath: localSkillPath,
    skill: loaded
  };
}

async function planLocalSkillImport(
  options: SkillToolsOptions,
  skills: LoadedSkill[]
): Promise<{ ok: true; skills: Array<{ skill: LoadedSkill; targetDir: string }> } | ToolResult> {
  if (skills.length === 0) {
    return errorResult("No SKILL.md files found to import.");
  }

  await mkdir(options.localSkillsRoot, { recursive: true });
  const seenNames = new Set<string>();
  const seenTargets = new Set<string>();
  const planned: Array<{ skill: LoadedSkill; targetDir: string }> = [];

  for (const skill of skills) {
    if (seenNames.has(skill.name)) {
      return errorResult(`skill.import found duplicate skill name ${skill.name}; import would be ambiguous.`);
    }
    seenNames.add(skill.name);

    const existing = options.registry.get(skill.name);
    if (existing !== undefined) {
      return errorResult(`skill.import refused ${skill.name}; a skill with that name is already registered.`);
    }

    const contained = await ensureContainedDirectory(options.localSkillsRoot, slugifySkillName(skill.name));
    if (!contained.ok) {
      return errorResult(contained.reason);
    }
    const targetDir = contained.path;
    if (seenTargets.has(targetDir)) {
      return errorResult(`skill.import refused ${skill.name}; multiple imported skills would target ${targetDir}.`);
    }
    seenTargets.add(targetDir);

    if (await stat(targetDir).catch(() => undefined) !== undefined) {
      return errorResult(`skill.import refused ${skill.name}; local target already exists at ${targetDir}.`);
    }

    planned.push({
      skill,
      targetDir
    });
  }

  return {
    ok: true,
    skills: planned
  };
}

async function resolveSkillSupportPath(
  skillDir: string,
  requestedPath: string
): Promise<{ ok: true; path: string; relativePath: string } | ToolResult> {
  if (!isSafeRelativeSkillPath(requestedPath)) {
    return errorResult("Skill support file path must be a safe relative path inside the skill directory.");
  }
  const contained = await ensureContainedDirectory(skillDir, requestedPath);
  if (!contained.ok) {
    return errorResult(contained.reason);
  }
  const target = contained.path;
  const relativePath = relative(skillDir, target);
  const existingTarget = await lstat(target).catch(() => undefined);
  if (existingTarget?.isSymbolicLink() === true) {
    return errorResult("Supporting file path cannot target an existing symlink.");
  }

  if (
    relativePath.length === 0 ||
    relativePath.startsWith("..") ||
    relativePath.startsWith("/") ||
    isReservedSkillSupportPath(relativePath)
  ) {
    return errorResult("Supporting file path must stay inside the skill directory and cannot target reserved skill metadata.");
  }

  return {
    ok: true,
    path: target,
    relativePath
  };
}

function isSkillSupportTarget(
  value: { ok: true; path: string; relativePath: string } | ToolResult
): value is { ok: true; path: string; relativePath: string } {
  return value.ok === true && "path" in value && "relativePath" in value;
}

function isReservedSkillSupportPath(relativePath: string): boolean {
  const normalized = relativePath.split("\\").join("/");

  return normalized === "SKILL.md" ||
    normalized === ".usage.json" ||
    normalized === ".bundled_manifest.json" ||
    normalized.startsWith(".archive/") ||
    normalized.startsWith(".snapshots/");
}

function countOccurrences(content: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }

  let count = 0;
  let index = 0;
  while (true) {
    const next = content.indexOf(needle, index);
    if (next === -1) {
      return count;
    }
    count++;
    index = next + needle.length;
  }
}

function applySkillPatch(content: string, patch: SkillPatchOperation): string {
  if (patch.type === "text_patch") {
    const occurrences = countOccurrences(content, patch.oldString);
    if (occurrences === 0) {
      throw new Error("Proposed text patch target was not found.");
    }
    if (occurrences > 1 && patch.replaceAll !== true) {
      throw new Error("Proposed text patch matched multiple occurrences without replaceAll.");
    }
    return patch.replaceAll === true
      ? content.split(patch.oldString).join(patch.newString)
      : content.replace(patch.oldString, patch.newString);
  }

  const parsed = splitSkillFile(content);
  const frontmatter = parsed.frontmatter.trim();
  if (!frontmatter.startsWith("{")) {
    throw new Error("json_frontmatter_patch can only promote into skills with JSON frontmatter.");
  }
  const document = JSON.parse(frontmatter) as unknown;
  if (!isRecord(document)) {
    throw new Error("Skill frontmatter must be a JSON object.");
  }
  applyJsonPointerPatch(document, patch.path, patch.value, patch.operation ?? "add");
  return `---\n${JSON.stringify(document, null, 2)}\n---\n${parsed.instructions}`;
}

function splitSkillFile(content: string): { frontmatter: string; instructions: string } {
  const match = /^---\n(?<frontmatter>[\s\S]*?)\n---\n?(?<instructions>[\s\S]*)$/u.exec(content);
  if (match?.groups === undefined) {
    throw new Error("Skill file must start with frontmatter wrapped in --- markers");
  }
  return {
    frontmatter: match.groups.frontmatter,
    instructions: match.groups.instructions
  };
}

function applyJsonPointerPatch(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
  operation: "add" | "replace"
): void {
  const parts = parseJsonPointer(path);
  if (parts.length === 0) {
    throw new Error("Patch path cannot target the frontmatter root.");
  }
  let cursor: unknown = target;
  for (const part of parts.slice(0, -1)) {
    if (Array.isArray(cursor)) {
      const index = Number(part);
      cursor = cursor[index];
      continue;
    }
    if (!isRecord(cursor)) {
      throw new Error(`Patch path cannot descend through ${part}.`);
    }
    cursor = cursor[part];
  }
  const key = parts[parts.length - 1]!;
  if (Array.isArray(cursor)) {
    if (key === "-") {
      cursor.push(value);
      return;
    }
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index > cursor.length) {
      throw new Error(`Invalid array patch index: ${key}`);
    }
    if (operation === "replace" && index >= cursor.length) {
      throw new Error(`Cannot replace missing array index: ${key}`);
    }
    cursor[index] = value;
    return;
  }
  if (!isRecord(cursor)) {
    throw new Error("Patch path parent is not an object or array.");
  }
  if (operation === "replace" && !(key in cursor)) {
    throw new Error(`Cannot replace missing object key: ${key}`);
  }
  cursor[key] = value;
}

function parseJsonPointer(path: string): string[] {
  if (!path.startsWith("/")) {
    throw new Error("JSON patch path must start with /.");
  }
  return path
    .slice(1)
    .split("/")
    .map((part) => part.replace(/~1/gu, "/").replace(/~0/gu, "~"));
}

async function snapshotLocalSkillTarget(
  options: SkillToolsOptions,
  target: { ok: true; skillDir: string; skillPath: string; skill?: LoadedSkill },
  name: string
): Promise<string> {
  const slug = slugifySkillName(name);
  const snapshotRoot = join(options.localSkillsRoot, ".snapshots", slug);
  const snapshotPath = join(snapshotRoot, timestampForPath());
  await mkdir(snapshotRoot, { recursive: true });
  await cp(target.skillDir, snapshotPath, { recursive: true });
  return snapshotPath;
}

async function archiveLocalSkillTarget(
  options: SkillToolsOptions,
  target: { ok: true; skillDir: string; skillPath: string },
  name: string
): Promise<string> {
  const slug = slugifySkillName(name);
  const archiveRoot = join(options.localSkillsRoot, ".archive", slug);
  const archivePath = join(archiveRoot, timestampForPath());
  await mkdir(archiveRoot, { recursive: true });
  await rename(target.skillDir, archivePath);
  return archivePath;
}

async function resolveSkillSnapshotPath(
  options: SkillToolsOptions,
  name: string,
  requestedPath: string | undefined
): Promise<{ ok: true; path: string } | ToolResult> {
  const snapshotRoot = resolve(options.localSkillsRoot, ".snapshots", slugifySkillName(name));
  const snapshotPath = requestedPath === undefined
    ? await latestSnapshotPath(snapshotRoot)
    : resolve(requestedPath);
  if (snapshotPath === undefined) {
    return errorResult(`No snapshots found for skill ${name}.`);
  }
  const canonicalRoot = await realpath(snapshotRoot).catch(() => undefined);
  const canonicalSnapshot = await realpath(snapshotPath).catch(() => undefined);
  if (canonicalRoot === undefined || canonicalSnapshot === undefined) {
    return errorResult(`Skill snapshot not found: ${snapshotPath}`);
  }
  const relativeSnapshot = relative(canonicalRoot, canonicalSnapshot);
  if (relativeSnapshot.startsWith("..") || relativeSnapshot.startsWith("/")) {
    return errorResult("Skill snapshot path must stay inside the local skill snapshot directory.");
  }
  const skillFile = await stat(join(canonicalSnapshot, "SKILL.md")).catch(() => undefined);
  if (skillFile === undefined || !skillFile.isFile()) {
    return errorResult(`Skill snapshot does not contain SKILL.md: ${canonicalSnapshot}`);
  }
  return {
    ok: true,
    path: canonicalSnapshot
  };
}

async function latestSnapshotPath(snapshotRoot: string): Promise<string | undefined> {
  const entries = await readdir(snapshotRoot, { withFileTypes: true }).catch(() => []);
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const latest = directories.at(-1);
  return latest === undefined ? undefined : join(snapshotRoot, latest);
}

function timestampForPath(): string {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

async function readSkillReference(skill: LoadedSkill, path: string): Promise<ToolResult> {
  const skillRoot = await realpath(dirname(skill.sourcePath));
  const candidate = resolve(skillRoot, path);
  const canonical = await realpath(candidate).catch(() => undefined);

  if (canonical === undefined) {
    return errorResult(`Skill reference not found: ${path}`);
  }

  const relativePath = relative(skillRoot, canonical);
  if (relativePath.startsWith("..") || relativePath.startsWith("/")) {
    return errorResult("Skill reference path is outside the skill directory.");
  }

  const metadata = await stat(canonical).catch(() => undefined);
  if (metadata === undefined || !metadata.isFile()) {
    return errorResult(`Skill reference is not a file: ${path}`);
  }
  if (metadata.size > MAX_SKILL_RESOURCE_BYTES) {
    return errorResult(`Skill reference ${relativePath} is ${metadata.size} bytes; maximum readable resource size is ${MAX_SKILL_RESOURCE_BYTES} bytes.`);
  }

  const content = await readFile(canonical);
  const inferredKind = skill.resources?.find((resource) => resource.path === relativePath)?.kind;

  if (!isProbablyText(content)) {
    return {
      ok: true,
      content: [
        `# ${skill.name} / ${relativePath}`,
        "",
        "This resource is not plain text. Use its metadata and route it through the appropriate media/document tool if you need to inspect the contents."
      ].join("\n"),
      metadata: {
        skill: skill.name,
        path: relativePath,
        kind: inferredKind ?? inferSkillResourceKind(relativePath),
        bytes: metadata?.size ?? content.byteLength,
        text: false
      }
    };
  }

  const decoded = content.toString("utf8");
  const truncated = truncateContextDocument(decoded, MAX_SKILL_RESOURCE_CHARS);

  return {
    ok: true,
    content: `# ${skill.name} / ${relativePath}\n\n${truncated.content}`,
    metadata: {
      skill: skill.name,
      path: relativePath,
      kind: inferredKind ?? inferSkillResourceKind(relativePath),
      bytes: metadata?.size ?? content.byteLength,
      text: true,
      truncated: truncated.truncated,
      originalChars: truncated.originalChars,
      headChars: truncated.headChars,
      tailChars: truncated.tailChars
    }
  };
}

function isProbablyText(content: Buffer): boolean {
  const sample = content.subarray(0, Math.min(content.byteLength, 2048));
  let controlBytes = 0;
  for (const byte of sample) {
    if (byte === 0) {
      return false;
    }
    if (byte < 9 || (byte > 13 && byte < 32)) {
      controlBytes++;
    }
  }
  return controlBytes / Math.max(1, sample.byteLength) < 0.1;
}

function inferSkillResourceKind(path: string): string {
  if (path.startsWith("references/")) return "reference";
  if (path.startsWith("templates/")) return "template";
  if (path.startsWith("scripts/")) return "script";
  if (path.startsWith("assets/")) return "asset";
  return "resource";
}

function renderJsonFrontmatter(definition: SkillDefinition): string {
  return JSON.stringify(pruneUndefined(definition), null, 2);
}

function pruneUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(pruneUndefined);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, pruneUndefined(entry)])
    );
  }
  return value;
}
