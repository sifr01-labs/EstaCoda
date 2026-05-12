import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

type EvalTask = {
  id: string;
  title: string;
  channel: "cli" | "telegram" | "provider" | "cross-cutting";
  evidence: "live-proven" | "smoke-tested" | "implemented but not live-proven" | "intended but not implemented";
  goal: string;
  prompt?: string;
  prerequisites?: string[];
  steps: string[];
  assertions: string[];
  notes?: string[];
};

const workspaceRoot = process.cwd();
const timestamp = formatTimestamp(new Date());
const tasksDir = join(workspaceRoot, "evals", "tasks");
const runRoot = join(workspaceRoot, ".estacoda", "eval-runs", timestamp);
const logsDir = join(runRoot, "logs");
const artifactsDir = join(runRoot, "artifacts");
const failuresDir = join(runRoot, "failures");
const notesPath = join(runRoot, "notes.md");
const commandsPath = join(runRoot, "commands.md");
const manifestPath = join(runRoot, "manifest.json");
const resultsPath = join(runRoot, "results.json");

const taskFiles = (await readdir(tasksDir))
  .filter((file) => file.endsWith(".json"))
  .sort();
const tasks = await Promise.all(taskFiles.map(async (file) => parseTask(await readFile(join(tasksDir, file), "utf8"), file)));

await mkdir(logsDir, { recursive: true });
await mkdir(artifactsDir, { recursive: true });
await mkdir(failuresDir, { recursive: true });

const environment = {
  createdAt: new Date().toISOString(),
  workspaceRoot,
  runRoot,
  branch: await git("rev-parse --abbrev-ref HEAD"),
  commit: await git("rev-parse --short HEAD"),
  taskFiles
};

const results = {
  createdAt: environment.createdAt,
  branch: environment.branch,
  commit: environment.commit,
  tasks: tasks.map((task) => ({
    id: task.id,
    title: task.title,
    status: "pending",
    observed: "",
    evidence: task.evidence,
    artifacts: [] as string[]
  }))
};

await writeFile(manifestPath, `${JSON.stringify({ environment, tasks }, null, 2)}\n`, "utf8");
await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
await writeFile(notesPath, renderNotes(environment, tasks), "utf8");
await writeFile(commandsPath, renderCommands(environment, tasks), "utf8");

console.log([
  "EstaCoda evaluation substrate initialized.",
  `Run root: ${runRoot}`,
  `Manifest: ${manifestPath}`,
  `Results: ${resultsPath}`,
  `Notes: ${notesPath}`,
  `Commands: ${commandsPath}`,
  "",
  "Suggested next steps:",
  "1. Open commands.md and run the evaluation tasks in order.",
  "2. Record pass/fail and observations in results.json and notes.md.",
  "3. Drop logs, screenshots, and generated outputs into logs/, failures/, or artifacts/."
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

function parseTask(raw: string, file: string): EvalTask {
  const parsed = JSON.parse(raw) as Partial<EvalTask>;
  if (
    typeof parsed.id !== "string" ||
    typeof parsed.title !== "string" ||
    typeof parsed.channel !== "string" ||
    typeof parsed.evidence !== "string" ||
    typeof parsed.goal !== "string" ||
    !Array.isArray(parsed.steps) ||
    !Array.isArray(parsed.assertions)
  ) {
    throw new Error(`Invalid eval task schema in ${file}`);
  }

  return {
    id: parsed.id,
    title: parsed.title,
    channel: parsed.channel as EvalTask["channel"],
    evidence: parsed.evidence as EvalTask["evidence"],
    goal: parsed.goal,
    prompt: parsed.prompt,
    prerequisites: parsed.prerequisites ?? [],
    steps: parsed.steps,
    assertions: parsed.assertions,
    notes: parsed.notes ?? []
  };
}

function renderNotes(
  environment: {
    createdAt: string;
    workspaceRoot: string;
    runRoot: string;
    branch: string;
    commit: string;
  },
  tasks: EvalTask[]
): string {
  return [
    "# EstaCoda Evaluation Run",
    "",
    `- Created: ${environment.createdAt}`,
    `- Workspace: ${environment.workspaceRoot}`,
    `- Branch: ${environment.branch}`,
    `- Commit: ${environment.commit}`,
    `- Run root: ${environment.runRoot}`,
    "",
    "## Purpose",
    "",
    "This runbook is the Phase 0 evaluation substrate for future self-evolution work. It does not evolve the agent by itself.",
    "It creates a repeatable place to run fixed tasks, capture evidence, and compare future candidates against a known baseline.",
    "",
    "## Tasks",
    "",
    ...tasks.map((task) => `- [ ] ${task.id} — ${task.title} (${task.channel}, ${task.evidence})`),
    "",
    "## Observations",
    "",
    "Record what passed, what failed, and whether the result was reproducible.",
    "",
    "## Candidate Comparison",
    "",
    "| Task | Baseline Result | Candidate Result | Regressed? | Notes |",
    "| --- | --- | --- | --- | --- |",
    "| | | | | |",
    "",
    "## Follow-ups",
    "",
    "- ",
    ""
  ].join("\n");
}

function renderCommands(
  environment: {
    workspaceRoot: string;
    branch: string;
    commit: string;
  },
  tasks: EvalTask[]
): string {
  const lines = [
    "# EstaCoda Evaluation Commands",
    "",
    `Branch: ${environment.branch}`,
    `Commit: ${environment.commit}`,
    "",
    "## Baseline Checks",
    "",
    "```bash",
    `cd ${environment.workspaceRoot}`,
    "pnpm run typecheck",
    "pnpm run smoke",
    "pnpm run dev -- doctor --live",
    "```",
    ""
  ];

  for (const task of tasks) {
    lines.push(`## ${task.id} — ${task.title}`, "");
    lines.push(`Goal: ${task.goal}`, "");
    if (task.prerequisites !== undefined && task.prerequisites.length > 0) {
      lines.push("Prerequisites:");
      for (const prerequisite of task.prerequisites) {
        lines.push(`- ${prerequisite}`);
      }
      lines.push("");
    }
    if (task.prompt !== undefined) {
      lines.push("Suggested prompt:");
      lines.push("");
      lines.push("```text");
      lines.push(task.prompt);
      lines.push("```");
      lines.push("");
    }
    lines.push("Steps:");
    for (const step of task.steps) {
      lines.push(`- ${step}`);
    }
    lines.push("");
    lines.push("Assertions:");
    for (const assertion of task.assertions) {
      lines.push(`- ${assertion}`);
    }
    if (task.notes !== undefined && task.notes.length > 0) {
      lines.push("");
      lines.push("Notes:");
      for (const note of task.notes) {
        lines.push(`- ${note}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
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
