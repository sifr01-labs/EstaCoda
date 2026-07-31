import { defaultProfileId, readActiveProfile } from "../config/profile-home.js";
import { resolveStateHome } from "../config/state-home.js";
import {
  ensureGlobalStateBootstrap,
  GLOBAL_STATE_DIRECTORIES
} from "../storage/state-bootstrap.js";
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

export async function runInitCommand(options: InitOptions): Promise<InitResult> {
  const stateHome = resolveStateHome({ homeDir: options.homeDir });
  const homeDir = stateHome.homeDir;
  if (homeDir.length === 0) {
    return {
      ok: false,
      output: "Error: HOME is not set. Use --home <dir> to specify a home directory.",
      exitCode: 1
    };
  }
  const profileId = readActiveProfile({ homeDir }).profileId ?? defaultProfileId();

  const root = stateHome.stateRoot;

  try {
    await ensureGlobalStateBootstrap({ homeDir });
    await ensureDefaultProfileState({ homeDir, profileId });

    return {
      ok: true,
      output: [
        "EstaCoda state initialized.",
        `Home: ${root}`,
        "Created:",
        ...GLOBAL_STATE_DIRECTORIES.map((d) => `  ${d}/`),
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
