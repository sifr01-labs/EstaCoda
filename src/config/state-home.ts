import { homedir } from "node:os";
import { join } from "node:path";

export type StateHomePaths = {
  homeDir: string;
  stateRoot: string;
  trustJsonPath: string;
  sessionsSqlitePath: string;
  skillsPath: string;
  logsPath: string;
  channelMediaPath: string;
  audioCachePath: string;
  imageCachePath: string;
  gatewayStatePath: string;
  tempPath: string;
};

// Returns global state paths only. Profile-scoped config/auth/env/runtime
// paths live in profile-home.ts.
export function resolveStateHome(options?: { homeDir?: string }): StateHomePaths {
  const homeDir = options?.homeDir ?? process.env.HOME ?? homedir() ?? "";
  const stateRoot = join(homeDir, ".estacoda");
  return {
    homeDir,
    stateRoot,
    trustJsonPath: join(stateRoot, "trust.json"),
    sessionsSqlitePath: join(stateRoot, "sessions.sqlite"),
    skillsPath: join(stateRoot, "skills"),
    logsPath: join(stateRoot, "logs"),
    channelMediaPath: join(stateRoot, "channel-media"),
    audioCachePath: join(stateRoot, "audio-cache"),
    imageCachePath: join(stateRoot, "image-cache"),
    gatewayStatePath: join(stateRoot, "gateway"),
    tempPath: join(stateRoot, "temp")
  };
}
