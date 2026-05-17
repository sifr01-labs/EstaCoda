import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultProfileId, readActiveProfile } from "../config/profile-home.js";
import { resolveStateHome } from "../config/state-home.js";
import { ensureDefaultProfileState } from "./profile-state.js";

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
  "memory/shared",
  "packs",
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

    await ensureDefaultProfileState({ homeDir: options.homeDir, profileId });
    await writeFileIfAbsent(stateHome.trustJsonPath, "{}\n");

    return {
      ok: true,
      output: [
        "EstaCoda state initialized.",
        `Home: ${root}`,
        "Created:",
        ...DEFAULT_STATE_DIRS.map((d) => `  ${d}/`),
        "  config.json",
        "  .env",
        "  auth.json",
        "  USER.md",
        "  SOUL.md",
        "  MEMORY.md",
        "  promotions.json",
        "  skills/",
        "  cron/",
        "  logs/",
        "  gateway/",
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
