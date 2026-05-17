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

async function openCuratorService(options: CliOptions): Promise<SkillProposalService> {
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

export async function curatorCommand(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const [subcommand, ...restArgs] = args;

  const service = await openCuratorService(options);

  switch (subcommand) {
    case "status":
      return curatorStatus(service, restArgs);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return {
        handled: true,
        exitCode: 0,
        output: curatorHelp()
      };
    default:
      return {
        handled: true,
        exitCode: 1,
        output: `Unknown curator subcommand: ${subcommand}\n\n${curatorHelp()}`
      };
  }
}

function curatorHelp(): string {
  return [
    "EstaCoda curator commands",
    "  estacoda curator status    Show aggregated evolution status"
  ].join("\n");
}

async function curatorStatus(service: SkillProposalService, _args: string[]): Promise<CliCommandResult> {
  const proposals = await service.listProposals();
  const manifests = await service.listManifests();

  const byStatus = (items: { status: string }[]) => {
    const counts: Record<string, number> = {};
    for (const item of items) {
      counts[item.status] = (counts[item.status] ?? 0) + 1;
    }
    return counts;
  };

  const proposalCounts = byStatus(proposals);
  const manifestCounts = byStatus(manifests);

  const lines = [
    "Curator Status",
    "",
    `Proposals: ${proposals.length}`,
    ...Object.entries(proposalCounts).map(([status, count]) => `  ${status}: ${count}`),
    "",
    `Manifests: ${manifests.length}`,
    ...Object.entries(manifestCounts).map(([status, count]) => `  ${status}: ${count}`),
  ];

  return {
    handled: true,
    exitCode: 0,
    output: lines.join("\n")
  };
}
