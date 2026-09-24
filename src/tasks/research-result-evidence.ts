import type { Task, TaskStep } from "../contracts/task.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import type { TaskStore } from "./task-store.js";
import { readTaskResultEvidence } from "./task-result-read-evidence.js";

const CLAIM_HEADER = "| Source URL | Supported claim | Limitation |";
const SOURCE_HEADER = "| Source URL | Published/revised | Retrieved | Access | Supported claim | Limitation |";
const MAX_ROWS = 24;
const MAX_TABLE_CHARS = 16_000;
export const RESEARCH_EVIDENCE_INSTRUCTION = `Include a bounded Markdown source/claim table (1-${MAX_ROWS} rows, no pipes inside cells):\n${CLAIM_HEADER}\n| --- | --- | --- |\nUse plain observed URLs, concise supported claims, and a concrete limitation for each claim. Never invent publication dates or claim full-text access from snippets. The runtime attaches observed publication/revision dates, retrieval dates and access status. Synthesis must read every accepted dependency result completely, preserve its evidence limitations and freshness scope, and cite only their observed sources. For synthesis, copy supported-claim and limitation cells from the accepted worker tables unchanged; synthesize the narrative separately. A URL establishes provenance, not scientific truth.`;

type SourceRow = { url: string; published: string; retrieved: string; access: string; claim: string; limitation: string };

export function requiresSourceTable(step: TaskStep, store: TaskStore): boolean {
  return step.executor.requestContract?.requirements.research !== undefined &&
    (step.executor.research?.requireLiveSources === true || step.dependsOn.some((id) => store.getStep(id)?.executor.research?.requireLiveSources === true));
}

/** No model statement is promoted into a retrieval/date/access receipt. */
export function groundResearchResult(input: { task: Task; step: TaskStep; store: TaskStore; text: string; executions: readonly ToolExecutionRecord[]; now: Date }): { text?: string; failure?: string } {
  if (!requiresSourceTable(input.step, input.store)) return { text: input.text };
  const table = parseTable(input.text);
  if (table === undefined) return { failure: "source-claim-table-missing" };
  const sources = new Map<string, Omit<SourceRow, "claim" | "limitation">>();
  const missing: string[] = [];
  const acceptedClaims = new Set<string>();
  if (input.step.executor.role === "synthesis") {
    const dependencies = input.step.dependsOn.map((id) => input.store.getStep(id));
    const ids = new Set(input.step.dependsOn);
    const accepted = input.store.listResults(input.task.id).filter((result) => result.status === "available" && result.disposition === "accepted" && result.stepId !== undefined && ids.has(result.stepId));
    const read = readTaskResultEvidence(input.executions, input.task.id);
    if (accepted.length === 0 || accepted.some((result) => !read.some((page) => page.id === result.id && page.contentHash === result.contentHash))) return { failure: "unread-worker-results" };
    for (const result of accepted) {
      const worker = parseTable(read.find((page) => page.id === result.id)!.content);
      if (worker === undefined || worker.rows.some((row) => row.retrieved === "unknown")) return { failure: "worker-source-table-missing" };
      for (const row of worker.rows) {
        acceptedClaims.add(JSON.stringify([row.url, row.claim, row.limitation]));
        if (!sources.has(row.url)) sources.set(row.url, row);
      }
      if (!worker.rows.some((row) => table.rows.some((candidate) => candidate.url === row.url))) return { failure: "worker-source-coverage-missing" };
    }
    if (table.rows.some((row) => !acceptedClaims.has(JSON.stringify([row.url, row.claim, row.limitation])))) return { failure: "changed-source-claim" };
    for (const step of dependencies) {
      if (step === null || step.status !== "completed" || !accepted.some((result) => result.stepId === step.id)) {
        missing.push(step?.executor.research?.scope ?? step?.title ?? "unavailable scope");
      }
    }
  } else {
    for (const execution of input.executions) {
      if (execution.decision !== "allow" || execution.result?.ok !== true) continue;
      const m = execution.result.metadata;
      const observed = execution.tool.name === "web.search" && Array.isArray(m?.results) ? m.results
        : execution.tool.name === "web.extract" && m?.url !== undefined ? [m] : [];
      for (const item of observed.slice(0, 24)) {
        if (item === null || typeof item !== "object") continue;
        const source = item as Record<string, unknown>;
        const url = httpUrl(source.url);
        if (url === undefined) continue;
        const extracted = execution.tool.name === "web.extract";
        const content = String(source.content ?? source.snippet ?? "").slice(0, 24_000);
        const date = /\b(?:published|revised|updated)(?:\s+on)?\s*:?\s*(\d{4}-\d{2}-\d{2})\b/iu.exec(content)?.[1];
        const previous = sources.get(url);
        // Reuse retains the original observation's retrieval date, including a
        // turn that crosses midnight. Missing provenance cannot become "now".
        const retrievedAt = extracted && typeof source.retrievedAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(source.retrievedAt)
          ? source.retrievedAt.slice(0, 10) : execution.readReuseOf !== undefined ? previous?.retrieved ?? "unknown" : input.now.toISOString().slice(0, 10);
        sources.set(url, { url, published: date ?? previous?.published ?? "unknown", retrieved: retrievedAt,
          access: extracted ? "extracted; full text unverified" : previous?.access ?? "snippet; full text unavailable" });
      }
    }
  }
  if (table.rows.some((row) => !sources.has(row.url)) || urls(input.text).some((url) => !sources.has(url))) return { failure: "unobserved-source" };
  const rows = table.rows.map((row) => ({ ...sources.get(row.url)!, claim: row.claim, limitation: row.limitation }));
  const rendered = [SOURCE_HEADER, "| --- | --- | --- | --- | --- | --- |", ...rows.map((row) => `| ${row.url} | ${row.published} | ${row.retrieved} | ${row.access} | ${row.claim} | ${row.limitation} |`)].join("\n");
  const prefix = input.step.executor.role !== "synthesis" ? "" : missing.length > 0
    ? `Research coverage is partial. Missing or failed scopes: ${missing.join(", ")}. Conclusions are limited to the accepted evidence.\n\n`
    : "Research coverage: all requested worker scopes returned accepted evidence.\n\n";
  const freshness = input.step.executor.role === "synthesis" && input.step.executor.requestContract?.requirements.research?.fresh
    ? "Freshness: live searches were required; observed publication/revision dates and retrieval dates appear below. Unknown publication dates do not establish recency.\n\n" : "";
  return { text: prefix + freshness + input.text.slice(0, table.start) + rendered + input.text.slice(table.end) };
}

function parseTable(text: string): { rows: SourceRow[]; start: number; end: number } | undefined {
  const header = text.includes(SOURCE_HEADER) ? SOURCE_HEADER : CLAIM_HEADER;
  const start = text.indexOf(header);
  if (start < 0 || text.indexOf(header, start + header.length) >= 0) return undefined;
  const block = text.slice(start).split("\n");
  if (!/^\|(?:\s*:?-+:?\s*\|){3,6}\s*$/u.test(block[1] ?? "")) return undefined;
  const rows: SourceRow[] = [];
  let end = start + block[0]!.length + 1 + block[1]!.length;
  for (const line of block.slice(2)) {
    if (!line.startsWith("|")) break;
    end += line.length + 1;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (!line.endsWith("|") || cells.length !== (header === SOURCE_HEADER ? 6 : 3) || cells.some((cell) => cell.length === 0 || cell.length > 600)) return undefined;
    const url = httpUrl(cells[0]);
    if (url === undefined) return undefined;
    rows.push({ url, published: header === SOURCE_HEADER ? cells[1]! : "unknown", retrieved: header === SOURCE_HEADER ? cells[2]! : "unknown",
      access: header === SOURCE_HEADER ? cells[3]! : "unknown", claim: cells.at(-2)!, limitation: cells.at(-1)! });
    if (rows.length > MAX_ROWS || end - start > MAX_TABLE_CHARS) return undefined;
  }
  return rows.length === 0 ? undefined : { rows, start, end };
}
function httpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 600) return undefined;
  try { const url = new URL(value); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined; url.hash = ""; return url.href; } catch { return undefined; }
}
function urls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>"'\[\]{}()|]+/giu)].flatMap((match) => {
    const url = httpUrl(match[0].replace(/[.,;:!?]+$/u, "")); return url === undefined ? [] : [url];
  });
}
