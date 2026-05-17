import { join } from "node:path";
import { homedir } from "node:os";
import type { CliCommandResult, CliOptions } from "./cli.js";
import { defaultProfileId, readActiveProfile, resolveProfileStateHome } from "../config/profile-home.js";
import { SkillRegistry } from "../skills/skill-registry.js";
import { loadSkillsFromDirectory } from "../skills/skill-loader.js";
import { SkillEvolutionStore } from "../skills/skill-evolution.js";
import { ChangeManifestStore } from "../skills/change-manifest-store.js";
import { SkillProposalService } from "../skills/skill-proposal-service.js";

function resolveHome(options: CliOptions): string {
  return options.homeDir ?? process.env.HOME ?? homedir();
}

async function openProposalService(options: CliOptions): Promise<SkillProposalService> {
  const home = resolveHome(options);
  const profileId = readActiveProfile({ homeDir: home }).profileId ?? defaultProfileId();
  const localSkillsRoot = resolveProfileStateHome({ homeDir: home, profileId }).skillsPath;
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
  return new SkillProposalService({
    registry,
    localSkillsRoot,
    skillEvolutionStore,
    changeManifestStore
  });
}

export async function proposalCommand(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const [subcommand, ...restArgs] = args;

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
    "  estacoda proposal list                 List all skill patch proposals",
    "  estacoda proposal list --skill <name>  Filter by skill name",
    "  estacoda proposal list --status <s>    Filter by status (proposed|promoted|rejected)",
    "  estacoda proposal inspect <id>         Show proposal details with review",
    "  estacoda proposal approve <id>         Mark proposal as approved",
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

  const lines = proposals.map((p) => {
    const risk = "riskLevel" in p ? String(p.riskLevel) : "?";
    return `${p.id}  ${p.status.padEnd(10)}  ${p.skillName.padEnd(24)}  ${risk}`;
  });

  return {
    handled: true,
    exitCode: 0,
    output: ["id                        status      skillName                 risk", ...lines].join("\n")
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

  const review = await service.reviewProposal(proposal);
  return {
    handled: true,
    exitCode: 0,
    output: JSON.stringify({ proposal, review }, null, 2)
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
