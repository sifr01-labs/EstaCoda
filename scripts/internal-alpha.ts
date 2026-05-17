import { chmod, mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const workspaceRoot = process.cwd();
const timestamp = formatTimestamp(new Date());
const runRoot = join(workspaceRoot, ".estacoda", "internal-alpha-runs", timestamp);
const logsDir = join(runRoot, "logs");
const failuresDir = join(runRoot, "failures");
const artifactsDir = join(runRoot, "artifacts");
const notesPath = join(runRoot, "notes.md");
const commandsPath = join(runRoot, "commands.md");
const envPath = join(runRoot, "environment.json");
const resetPath = join(runRoot, "reset.sh");

await mkdir(logsDir, { recursive: true });
await mkdir(failuresDir, { recursive: true });
await mkdir(artifactsDir, { recursive: true });

const environment = {
  createdAt: new Date().toISOString(),
  workspaceRoot,
  runRoot,
  branch: await git("rev-parse --abbrev-ref HEAD"),
  commit: await git("rev-parse --short HEAD")
};

await writeFile(envPath, `${JSON.stringify(environment, null, 2)}\n`, "utf8");
await writeFile(notesPath, renderNotes(environment), "utf8");
await writeFile(commandsPath, renderCommands(environment), "utf8");
await writeFile(resetPath, renderReset(environment), "utf8");
await chmod(resetPath, 0o755);

console.log([
  "EstaCoda internal alpha harness initialized.",
  `Run root: ${runRoot}`,
  `Notes: ${notesPath}`,
  `Commands: ${commandsPath}`,
  `Environment: ${envPath}`,
  `Reset script: ${resetPath}`,
  "",
  "Suggested next steps:",
  "1. Open commands.md and run the checks in order.",
  "2. Record failures and observations in notes.md.",
  "3. Drop any screenshots, logs, or outputs into failures/ or artifacts/."
].join("\n"));

async function git(args: string): Promise<string> {
  const result = spawnSync("git", ["-C", workspaceRoot, ...args.split(" ")], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (result.status !== 0) {
    throw new Error(`git ${args} failed: ${(result.stderr ?? "").trim()}`);
  }

  return (result.stdout ?? "").trim();
}

function renderNotes(input: {
  createdAt: string;
  workspaceRoot: string;
  runRoot: string;
  branch: string;
  commit: string;
}): string {
  return [
    "# EstaCoda Internal Alpha Run",
    "",
    `- Created: ${input.createdAt}`,
    `- Workspace: ${input.workspaceRoot}`,
    `- Branch: ${input.branch}`,
    `- Commit: ${input.commit}`,
    `- Run root: ${input.runRoot}`,
    "",
    "## Checklist",
    "",
    "- [ ] Preflight: `pnpm run typecheck`, `pnpm run smoke`, `pnpm run dev -- doctor --live`",
    "- [ ] CLI session with file edits",
    "- [ ] Selected skill execution",
    "- [ ] Approval-gated terminal task",
    "- [ ] Telegram text task",
    "- [ ] Telegram attachment task",
    "- [ ] Provider route checks: Kimi / OpenRouter / Ollama / DeepSeek",
    "- [ ] Memory/session sanity: `/reset`, resume note, trust behavior",
    "- [ ] Failure capture complete",
    "- [ ] Reset/rollback complete",
    "",
    "## Observations",
    "",
    "Use this section to record what worked, what broke, and how repeatable it was.",
    "",
    "## Failures",
    "",
    "| Area | Reproduction | Expected | Actual | Severity | Files / Logs |",
    "| --- | --- | --- | --- | --- | --- |",
    "| | | | | | |",
    "",
    "## Follow-ups",
    "",
    "- ",
    "",
    "## Artifacts",
    "",
    `- Logs directory: ${join(input.runRoot, "logs")}`,
    `- Failure captures: ${join(input.runRoot, "failures")}`,
    `- Output artifacts: ${join(input.runRoot, "artifacts")}`,
    ""
  ].join("\n");
}

function renderCommands(input: {
  workspaceRoot: string;
  runRoot: string;
  createdAt: string;
  branch: string;
  commit: string;
}): string {
  const root = input.workspaceRoot;
  const logFile = join(input.runRoot, "logs", "alpha-session.log");

  return [
    "# EstaCoda Internal Alpha Commands",
    "",
    `Run created: ${input.createdAt}`,
    `Branch: ${input.branch}`,
    `Commit: ${input.commit}`,
    "",
    "## Preflight",
    "",
    "```bash",
    `cd ${root}`,
    "pnpm run typecheck",
    "pnpm run smoke",
    "pnpm run dev -- doctor --live",
    "pnpm run dev -- gateway status",
    "```",
    "",
    "## CLI Session With File Edits",
    "",
    "```bash",
    `cd ${root}`,
    `script ${logFile}`,
    "pnpm run dev",
    "# inside session:",
    "/trust",
    "Create a file called alpha-proof.md with one sentence proving EstaCoda can edit files through tools, then read it back and confirm the exact contents.",
    "/reset",
    "/exit",
    "exit",
    "```",
    "",
    "## Selected Skill Execution",
    "",
    "```bash",
    `cd ${root}`,
    "pnpm run dev -- \"/ascii-video Tell me what inputs you need to generate a short ASCII logo animation for EstaCoda.\"",
    "```",
    "",
    "## Approval-Gated Terminal Task",
    "",
    "```bash",
    `cd ${root}`,
    "pnpm run dev",
    "# inside session:",
    "Use terminal.run to list the current directory and create a temp folder named alpha-gated-check, then tell me what approval was requested and why.",
    "```",
    "",
    "## Telegram Text And Attachment Tasks",
    "",
    "```bash",
    `cd ${root}`,
    "pnpm run dev -- gateway status",
    "pnpm run dev -- gateway start --telegram",
    "# then from Telegram:",
    "# 1. send a plain text task",
    "# 2. send an image or document",
    "# 3. capture any approval cards and resulting replies into failures/ if something looks off",
    "```",
    "",
    "## Provider Route Checks",
    "",
    "Run this after pointing config at each provider in turn or using separate configs:",
    "",
    "```bash",
    `cd ${root}`,
    "pnpm run dev -- doctor --live",
    "pnpm run dev -- \"Say hello as EstaCoda and summarize what you can do in one short paragraph.\"",
    "```",
    "",
    "## Failure Capture",
    "",
    "- Save screenshots into `failures/`.",
    "- Copy terminal transcripts into `logs/`.",
    "- Record the reproduction in `notes.md` immediately.",
    "",
    "## Reset / Rollback",
    "",
    "```bash",
    `cd ${root}`,
    shellEscape(join(input.runRoot, "reset.sh")),
    "```",
    ""
  ].join("\n");
}

function renderReset(input: {
  workspaceRoot: string;
  runRoot: string;
}): string {
  return [
    "#!/bin/zsh",
    "set -euo pipefail",
    "",
    `cd ${shellEscape(input.workspaceRoot)}`,
    "",
    "echo 'Resetting common internal-alpha artifacts...'",
    "rm -f alpha-proof.md",
    "rm -rf alpha-gated-check",
    "",
    `echo 'Harness run artifacts remain at ${shellEscape(input.runRoot)}'`,
    "echo 'If a Telegram gateway is running in another terminal, stop it there or send /stop from Telegram.'",
    "echo 'If you changed config intentionally for provider checks, restore it before the next run.'"
  ].join("\n");
}

function formatTimestamp(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  const hour = String(value.getHours()).padStart(2, "0");
  const minute = String(value.getMinutes()).padStart(2, "0");
  const second = String(value.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hour}${minute}${second}`;
}

function shellEscape(value: string): string {
  return `'${resolve(value).replaceAll("'", `'\\''`)}'`;
}
