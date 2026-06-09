import { join } from "node:path";
import { readFile, stat } from "node:fs/promises";
import type { CliCommandResult, CliOptions } from "./cli.js";
import { resolveHomeDir } from "../config/home-dir.js";
import { defaultProfileId, readActiveProfile, resolveProfileStateHome } from "../config/profile-home.js";
import { SkillRegistry } from "../skills/skill-registry.js";
import { loadSkillsFromDirectory } from "../skills/skill-loader.js";
import { SkillEvolutionStore } from "../skills/skill-evolution.js";
import { ChangeManifestStore } from "../skills/change-manifest-store.js";
import { SkillProposalService } from "../skills/skill-proposal-service.js";

function resolveHome(options: CliOptions): string {
  return resolveHomeDir(options.homeDir);
}

async function openManifestService(options: CliOptions): Promise<SkillProposalService> {
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

export async function manifestCommand(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const [subcommand, ...restArgs] = args;

  const service = await openManifestService(options);

  switch (subcommand) {
    case "list":
      return manifestList(service, restArgs);
    case "inspect":
      return manifestInspect(service, restArgs);
    case "diff":
      return manifestDiff(service, options, restArgs);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return {
        handled: true,
        exitCode: 0,
        output: manifestHelp()
      };
    default:
      return {
        handled: true,
        exitCode: 1,
        output: `Unknown manifest subcommand: ${subcommand}\n\n${manifestHelp()}`
      };
  }
}

function manifestHelp(): string {
  return [
    "EstaCoda manifest commands",
    "  estacoda manifest list                 List all evolution change manifests",
    "  estacoda manifest list --status <s>    Filter by status",
    "  estacoda manifest inspect <id>         Show manifest details",
    "  estacoda manifest diff <id>            Show read-only diff of filesChanged"
  ].join("\n");
}

async function manifestList(service: SkillProposalService, args: string[]): Promise<CliCommandResult> {
  const status = valueAfter(args, "--status");
  const manifests = await service.listManifests(status === undefined ? undefined : { status: status as import("../contracts/evolution.js").EvolutionChangeManifest["status"] });

  if (manifests.length === 0) {
    return {
      handled: true,
      exitCode: 0,
      output: "No manifests found."
    };
  }

  const lines = manifests.map((m) => {
    return `${m.id}  ${m.status.padEnd(10)}  ${m.target.padEnd(12)}  ${m.riskLevel}`;
  });

  return {
    handled: true,
    exitCode: 0,
    output: ["id                        status      target       risk", ...lines].join("\n")
  };
}

async function manifestInspect(service: SkillProposalService, args: string[]): Promise<CliCommandResult> {
  const id = args[0];
  if (id === undefined) {
    return {
      handled: true,
      exitCode: 1,
      output: "Usage: estacoda manifest inspect <manifest-id>"
    };
  }

  const manifest = await service.findManifest(id);
  if (manifest === undefined) {
    return {
      handled: true,
      exitCode: 1,
      output: `Manifest not found: ${id}`
    };
  }

  return {
    handled: true,
    exitCode: 0,
    output: JSON.stringify(manifest, null, 2)
  };
}

async function manifestDiff(
  service: SkillProposalService,
  options: CliOptions,
  args: string[]
): Promise<CliCommandResult> {
  const id = args[0];
  if (id === undefined) {
    return {
      handled: true,
      exitCode: 1,
      output: "Usage: estacoda manifest diff <manifest-id>"
    };
  }

  const manifest = await service.findManifest(id);
  if (manifest === undefined) {
    return {
      handled: true,
      exitCode: 1,
      output: `Manifest not found: ${id}`
    };
  }

  const home = resolveHome(options);
  const profileId = readActiveProfile({ homeDir: home }).profileId ?? defaultProfileId();
  const localSkillsRoot = resolveProfileStateHome({ homeDir: home, profileId }).skillsPath;
  const skillEvolutionStore = new SkillEvolutionStore({
    usagePath: join(localSkillsRoot, ".usage.json"),
    evolutionRoot: join(localSkillsRoot, ".evolution")
  });
  const proposals = await skillEvolutionStore.listProposals({});
  const linkedProposal = proposals.find((p) => p.changeManifestId === id);

  const lines: string[] = [`Manifest: ${id}`, `Target: ${manifest.target}`, `Status: ${manifest.status}`, ""];

  for (const filePath of manifest.filesChanged) {
    const fileStat = await stat(filePath).catch(() => undefined);
    if (fileStat === undefined) {
      lines.push(`--- ${filePath}`);
      lines.push("file does not exist (would be created)");
      lines.push("");
      continue;
    }

    const currentContent = await readFile(filePath, "utf8").catch(() => undefined);
    lines.push(`--- ${filePath}`);
    lines.push(`file exists (${fileStat.size} bytes)`);

    const linkedPatch = linkedProposal?.patch;
    if (linkedPatch?.type === "text_patch") {
      lines.push("");
      lines.push("Proposed patch:");
      lines.push(`- ${linkedPatch.oldString.replace(/\n/gu, "\\n")}`);
      lines.push(`+ ${linkedPatch.newString.replace(/\n/gu, "\\n")}`);
    } else if (linkedPatch?.type === "json_frontmatter_patch") {
      lines.push("");
      lines.push(`Proposed JSON patch: ${linkedPatch.path}`);
      lines.push(`+ ${JSON.stringify(linkedPatch.value)}`);
    }
    lines.push("");
  }

  if (manifest.filesChanged.length === 0) {
    lines.push("No filesChanged listed in manifest.");
  }

  return {
    handled: true,
    exitCode: 0,
    output: lines.join("\n")
  };
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}
