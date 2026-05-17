import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultProfileId, readActiveProfile, resolveProfileStateHome } from "../config/profile-home.js";
import { resolveStateHome } from "../config/state-home.js";

export type InitOptions = {
  homeDir?: string;
  yes?: boolean;
};

export type InitResult = {
  ok: boolean;
  output: string;
  exitCode: number;
};

export const DEFAULT_STATE_DIRS = [
  "memory",
  "skills",
  "skills/local",
  "skills/.evolution",
  "packs",
  "cron",
  "cron/output",
  "cron/locks",
  "logs",
  ".backups"
];

export async function bootstrapStateDirectories(homeDir: string): Promise<void> {
  const root = join(homeDir, ".estacoda");
  for (const dir of DEFAULT_STATE_DIRS) {
    await mkdir(join(root, dir), { recursive: true });
  }
}

function isFileAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function writeFileIfAbsent(path: string, contents: string): Promise<void> {
  try {
    await writeFile(path, contents, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (!isFileAlreadyExistsError(error)) {
      throw error;
    }
  }
}

export async function runInitCommand(options: InitOptions): Promise<InitResult> {
  const stateHome = resolveStateHome({ homeDir: options.homeDir });
  const profileId = readActiveProfile({ homeDir: options.homeDir }).profileId ?? defaultProfileId();
  const profileHome = resolveProfileStateHome({ homeDir: options.homeDir, profileId });
  const homeDir = stateHome.homeDir;
  if (homeDir.length === 0) {
    return {
      ok: false,
      output: "Error: HOME is not set. Use --home <dir> to specify a home directory.",
      exitCode: 1
    };
  }

  const root = stateHome.stateRoot;

  try {
    await bootstrapStateDirectories(homeDir);

    const defaultConfig = {
      model: {
        provider: "unconfigured",
        id: "unconfigured"
      },
      providers: {},
      skills: {
        autonomy: "suggest"
      },
      ui: {
        language: "en",
        flavor: "standard",
        activityLabels: "en"
      },
      security: {
        approvalMode: "confirm"
      }
    };
    await mkdir(profileHome.profileRoot, { recursive: true });
    await writeFileIfAbsent(profileHome.configPath, `${JSON.stringify(defaultConfig, null, 2)}\n`);
    await writeFileIfAbsent(stateHome.trustJsonPath, "{}\n");

    return {
      ok: true,
      output: [
        "EstaCoda state initialized.",
        `Home: ${root}`,
        "Created:",
        ...DEFAULT_STATE_DIRS.map((d) => `  ${d}/`),
        `  profiles/${profileId}/config.json`,
        "  trust.json",
        "",
        "Next: run `estacoda` to start interactive setup, or `estacoda verify` to check readiness."
      ].join("\n"),
      exitCode: 0
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      output: `Error initializing state: ${message}`,
      exitCode: 1
    };
  }
}
