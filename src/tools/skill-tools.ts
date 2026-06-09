import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { LoadedSkill, SkillDefinition, SkillEvaluation } from "../contracts/skill.js";
import type { RegisteredTool, SessionToolProvider, ToolResult } from "../contracts/tool.js";
import { SkillEvolutionStore, type SkillEvalRunRecord, type SkillObservationRecord, type SkillPatchOperation, type SkillPatchProposal, type SkillPatchRiskLevel, type SkillSourceTrust } from "../skills/skill-evolution.js";
import { resetBundledSkill } from "../skills/skill-bundled-sync.js";
import { MAX_SKILL_RESOURCE_BYTES, MAX_SKILL_RESOURCE_CHARS } from "../skills/skill-limits.js";
import { hydrateSkillResources, loadSkillsFromDirectory, parseSkillFile, truncateContextDocument } from "../skills/skill-loader.js";
import { assertSkillContentMutationAllowed, assertSkillMutable } from "../skills/skill-mutation-policy.js";
import { ensureContainedDirectory, isSafeRelativeSkillPath } from "../skills/skill-path-safety.js";
import type { SkillRegistry } from "../skills/skill-registry.js";
import { ChangeManifestStore } from "../skills/change-manifest-store.js";
import {
  SkillProposalService,
  type SkillEvalGateResult,
  runSkillEvalGate,
  recordSkillEvalRuns,
  compareEvalGates,
  classifyPatchRisk,
  evaluateProposalTrust,
  summarizePatchOperation,
  affectedFieldsForPatch,
  applySkillPatch,
  isLoadedSkill as isLoadedSkillFromService,
  slugifySkillName
} from "../skills/skill-proposal-service.js";
export { slugifySkillName } from "../skills/skill-proposal-service.js";

export type SkillToolsOptions = {
  registry: SkillRegistry;
  visibleRegistry?: SkillRegistry;
  localSkillsRoot: string;
  bundledSkillsRoot?: string;
  skillEvolutionStore?: SkillEvolutionStore;
  changeManifestStore?: ChangeManifestStore;
};

export function createSkillTools(options: SkillToolsOptions): readonly RegisteredTool[] {
  const proposalService = options.skillEvolutionStore !== undefined
    ? new SkillProposalService({
        registry: options.registry,
        localSkillsRoot: options.localSkillsRoot,
        skillEvolutionStore: options.skillEvolutionStore,
        changeManifestStore: options.changeManifestStore
      })
    : undefined;

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
      description: "Inspect skill metadata, playbook, examples, and evaluations without loading extra files.",
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
      description: "Run lightweight skill eval gates for routing, playbook tool expectations, and degraded behavior metadata.",
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
          selectedPlaybookStep: { type: "string" },
          toolsAttempted: { type: "array", items: { type: "string" } },
          outcome: { type: "string" },
          candidateImprovement: { type: "string" }
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
        selectedPlaybookStep?: string;
        toolsAttempted?: string[];
        outcome?: "succeeded" | "failed" | "blocked" | "partial";
        candidateImprovement?: string;
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
          selectedPlaybookStep: input.selectedPlaybookStep,
          toolsAttempted: input.toolsAttempted,
          outcome: input.outcome,
          candidateImprovement: input.candidateImprovement,
          ...deriveToolObservationTrust()
        });
        if (isNonEmptyString(input.candidateImprovement) && proposalService !== undefined) {
          await proposalService.createManifestFromObservation({
            skillName: input.name,
            lesson: input.lesson,
            candidateImprovement: input.candidateImprovement,
            observationId: observation.id,
            sourceTrust: observation.sourceTrust
          });
        }
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
        patch?: SkillPatchOperation;
      }) => {
        if (options.skillEvolutionStore === undefined) {
          return errorResult("Skill evolution store is not configured.");
        }
        if (!isNonEmptyString(input.name) || !isNonEmptyString(input.reason) || input.patch === undefined) {
          return errorResult("skill.propose_patch requires name, reason, and patch");
        }
        const skill = options.registry.get(input.name);
        const source = skill !== undefined && isLoadedSkill(skill) ? skill.sourceKind : undefined;
        const riskLevel = classifyPatchRisk(input.patch);
        let changeManifestId: string | undefined;
        if (proposalService !== undefined) {
          const manifestResult = await proposalService.createManifestFromProposal({
            skillName: input.name,
            reason: input.reason,
            patch: input.patch
          });
          changeManifestId = manifestResult?.manifestId;
        }
        const proposal = await options.skillEvolutionStore.proposePatch({
          skillName: input.name,
          source,
          reason: input.reason,
          confidence: input.confidence,
          observationIds: input.observationIds,
          successes: input.successes,
          failures: input.failures,
          ...deriveToolProposalTrust(),
          patch: input.patch,
          changeManifestId,
          hypothesis: input.reason,
          riskClass: riskLevel,
          authorityExpansion: riskLevel === "high",
          evalPlan: {
            command: "pnpm run eval:fixtures",
            constraintGates: ["pnpm run typecheck", "pnpm run smoke"]
          },
          rollbackExpectation: "Revert skill file using skill.rollback or restore from snapshot."
        });
        if (changeManifestId !== undefined && options.changeManifestStore !== undefined && input.observationIds !== undefined && input.observationIds.length > 0) {
          await options.changeManifestStore.linkEvidence(changeManifestId, {
            traces: input.observationIds
          });
        }
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
        if (proposalService === undefined) {
          return errorResult("Skill evolution store is not configured.");
        }
        const proposals = await proposalService.listProposals({
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
        if (proposalService === undefined) {
          return errorResult("Skill evolution store is not configured.");
        }
        const proposals = await proposalService.listProposals({
          skillName: input.name,
          status: input.status ?? "proposed"
        });
        const reviews = [];
        for (const proposal of proposals) {
          reviews.push(await proposalService.reviewProposal(proposal));
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
        if (proposalService === undefined) {
          return errorResult("Skill evolution store is not configured.");
        }
        const proposalId = firstNonEmptyString(input.proposal_id, input.proposalId);
        if (!isNonEmptyString(proposalId)) {
          return errorResult("skill.review_proposal requires proposal_id");
        }
        const proposal = await proposalService.findProposal(proposalId);
        if (proposal === undefined) {
          return errorResult(`Skill patch proposal not found: ${proposalId}`);
        }
        const review = await proposalService.reviewProposal(proposal);
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
        if (proposalService === undefined) {
          return errorResult("Skill evolution store is not configured.");
        }
        const proposalId = firstNonEmptyString(input.proposal_id, input.proposalId);
        if (!isNonEmptyString(proposalId)) {
          return errorResult("skill.approve_patch requires proposal_id");
        }
        const proposal = await proposalService.approveProposal(proposalId, input.approvedBy ?? "user");
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
        if (proposalService === undefined) {
          return errorResult("Skill evolution store is not configured.");
        }
        const proposalId = firstNonEmptyString(input.proposal_id, input.proposalId);
        if (!isNonEmptyString(proposalId)) {
          return errorResult("skill.reject_patch requires proposal_id");
        }
        const proposal = await proposalService.rejectProposal(proposalId);
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
        if (proposalService === undefined) {
          return errorResult("Skill evolution store is not configured.");
        }
        const proposalId = firstNonEmptyString(input.proposal_id, input.proposalId);
        if (!isNonEmptyString(proposalId)) {
          return errorResult("skill.promote_patch requires proposal_id");
        }
        const result = await proposalService.promoteProposal(proposalId);
        if (!result.ok) {
          return errorResult(result.reason);
        }
        return {
          ok: true,
          content: `Promoted skill patch ${proposalId} into ${result.skill.name}. Evals: ${result.evalGate.status}; smoke validation is recorded as not-run for this minimal gate.`,
          metadata: {
            promotion: result.promotion,
            evalGate: result.evalGate,
            snapshotPath: result.snapshotPath,
            skill: toSkillMetadata(result.skill)
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

export const skillToolProvider: SessionToolProvider = {
  name: "skill",
  kind: "session",
  createTools(ctx) {
    return createSkillTools({
      registry: requireProviderDependency("skill", "skillRegistry", ctx.skillRegistry),
      visibleRegistry: ctx.sessionSkillRegistry,
      localSkillsRoot: requireProviderDependency("skill", "localSkillsRoot", ctx.localSkillsRoot),
      bundledSkillsRoot: ctx.bundledSkillsRoot,
      skillEvolutionStore: ctx.skillEvolutionStore,
      changeManifestStore: ctx.changeManifestStore
    });
  }
};

function requireProviderDependency<T>(provider: string, dependency: string, value: T | undefined): T {
  if (value === undefined) {
    throw new TypeError(`${provider}ToolProvider requires ${dependency}.`);
  }
  return value;
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
    playbook: skill.playbook,
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
    playbook: [
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

function errorResult(content: string): ToolResult {
  return {
    ok: false,
    content
  };
}

function deriveToolObservationTrust(): {
  sourceTrust: SkillSourceTrust;
  mayPromoteAutomatically: boolean;
  requiresHumanApproval: boolean;
} {
  return {
    sourceTrust: "untrusted_document",
    mayPromoteAutomatically: false,
    requiresHumanApproval: true
  };
}

function deriveToolProposalTrust(): {
  sourceTrust: SkillSourceTrust;
  mayPromoteAutomatically: boolean;
  requiresHumanApproval: boolean;
} {
  return {
    sourceTrust: "untrusted_document",
    mayPromoteAutomatically: false,
    requiresHumanApproval: true
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
