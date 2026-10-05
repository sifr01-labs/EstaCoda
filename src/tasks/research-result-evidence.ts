import type { Task, TaskStep } from "../contracts/task.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import type { TaskStore } from "./task-store.js";
import { readTaskResultEvidence } from "./task-result-read-evidence.js";

const SOURCE_HEADER = "| Source URL | Published/revised | Retrieved | Access | Supported claim | Limitation |";
const MAX_TABLE_CHARS = 128_000;
export const RESEARCH_EVIDENCE_INSTRUCTION = `Cite observed URLs next to the claims they support. Explain source limitations and distinguish search snippets from retrieved text. A source/claim table is optional; the runtime attaches observed publication/revision dates, retrieval dates and access status. Never invent source observations or publication dates. A URL establishes provenance, not scientific truth.`;

export const SYNTHESIS_EVIDENCE_INSTRUCTION = "Read every accepted dependency result completely. Synthesize their findings in your own words, cite their observed sources, and preserve evidence limitations and freshness scope. The runtime retains the original worker source notes; do not copy table cells merely to satisfy formatting. Return only the report for its reader. File saving and completion status are handled by the delivery step; omit internal workflow or file-output commentary from the report.";

type SourceRow = { url: string; published: string; retrieved: string; access: string; claim: string; limitation: string };

export function requiresSourceTable(step: TaskStep, store: TaskStore): boolean {
  return step.executor.requestContract?.requirements.research !== undefined &&
    (step.executor.research?.requireLiveSources === true || step.dependsOn.some((id) => store.getStep(id)?.executor.research?.requireLiveSources === true));
}

/** No model statement is promoted into a retrieval/date/access receipt. */
export function groundResearchResult(input: { task: Task; step: TaskStep; store: TaskStore; text: string; executions: readonly ToolExecutionRecord[]; now: Date }): { text?: string; failure?: string; feedback?: string } {
  if (!requiresSourceTable(input.step, input.store)) return { text: input.text };
  const table = parseTable(input.text);
  const cited = [...new Set(researchCitationUrls(input.text))];
  if (cited.length === 0) return { failure: "source-citations-missing", feedback: "Cite observed sources beside the claims they support; a Markdown table is optional." };
  const sources = new Map<string, Omit<SourceRow, "claim" | "limitation">>();
  const missing: string[] = [];
  const acceptedRows: SourceRow[] = [];
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
        acceptedRows.push(row);
        if (!sources.has(row.url)) sources.set(row.url, row);
      }
      if (!worker.rows.some((row) => cited.includes(row.url))) return { failure: "worker-source-coverage-missing" };
    }
    for (const step of dependencies) {
      if (step === null || step.status !== "completed" || !accepted.some((result) => result.stepId === step.id)) {
        missing.push(step?.executor.research?.scope ?? step?.title ?? "unavailable scope");
      }
    }
  } else {
    for (const [url, source] of observedSources(input.executions, input.now)) sources.set(url, source);
  }
  const unobserved = [...new Set(cited.filter(url => !sources.has(url)))];
  if (unobserved.length > 0) return { failure: "unobserved-source",
    feedback: `These cited URLs have no successful source observation: ${unobserved.slice(0, 8).join(", ")}. Verify them with allowed tools, replace them with observed supporting sources, or remove unsupported claims. A failed retrieval is a limitation, not evidence. Return only the corrected report; do not repeat rejected URLs in explanations of removed citations.` };
  // Observations are runtime-owned; prose and claim notes remain model-authored.
  // Synthesis retains the original worker limitations independently of paraphrasing.
  const rows = input.step.executor.role === "synthesis"
    ? cited.map(url => {
      const notes = acceptedRows.filter(row => row.url === url);
      return { ...sources.get(url)!, claim: [...new Set(notes.map(row => row.claim))].join(" / "),
        limitation: [...new Set(notes.map(row => row.limitation))].join(" / ") };
    })
    : cited.map(url => {
      const row = table?.rows.find(row => row.url === url);
      return { ...sources.get(url)!, claim: row?.claim ?? "See cited narrative; claim support requires review",
        limitation: row?.limitation || "Source provenance verified; factual support requires review" };
    });
  const rendered = [SOURCE_HEADER, "| --- | --- | --- | --- | --- | --- |", ...rows.map((row) => `| ${row.url} | ${row.published} | ${row.retrieved} | ${row.access} | ${row.claim.replace(/\|/gu, "\\|")} | ${row.limitation.replace(/\|/gu, "\\|")} |`)].join("\n");
  if (rendered.length > MAX_TABLE_CHARS) return { failure: "source-notes-limit", feedback: "The retained source notes exceed the result size limit. Use fewer distinct sources while preserving worker scope coverage." };
  const prefix = input.step.executor.role !== "synthesis" ? "" : missing.length > 0
    ? `Research coverage is partial. Missing or failed scopes: ${missing.join(", ")}. Conclusions are limited to the accepted evidence.\n\n`
    : "Research coverage: all requested worker scopes returned accepted evidence.\n\n";
  const freshness = input.step.executor.role === "synthesis" && input.step.executor.requestContract?.requirements.research?.fresh
    ? "Freshness: live searches were required; observed publication/revision dates and retrieval dates appear below. Unknown publication dates do not establish recency.\n\n" : "";
  const access = rows.every(row => row.access.startsWith("snippet"))
    ? "Source access: search summaries only. Full text was not retrieved; acceptance checks source provenance, not scientific accuracy.\n\n" : "";
  const body = table === undefined ? `${input.text}\n\n${rendered}` : input.text.slice(0, table.start) + rendered + input.text.slice(table.end);
  return { text: prefix + freshness + (access && !body.startsWith(access) ? access : "") + body };
}

function parseTable(text: string): { rows: SourceRow[]; start: number; end: number } | undefined {
  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/u).map(cell => cell.trim().replace(/\\\|/gu, "|"));
    const header = cells(lines[i]!).map(cell => cell.replace(/[*_]/gu, "").toLowerCase());
    const urlIndex = header.findIndex(cell => /^(source url|source|url)$/u.test(cell));
    const claimIndex = header.findIndex(cell => /^(supported claim|claim|finding)$/u.test(cell));
    const limitationIndex = header.findIndex(cell => /^(limitation|limitations)$/u.test(cell));
    if (urlIndex < 0 || claimIndex < 0 || limitationIndex < 0 || !/^\s*\|?[\s:|+-]+\|?\s*$/u.test(lines[i + 1]!)) {
      offset += lines[i]!.length + 1; continue;
    }
    const start = offset;
    let end = start + lines[i]!.length + 1 + lines[i + 1]!.length;
    const rows: SourceRow[] = [];
    let invalid = false;
    for (let j = i + 2; j < lines.length && lines[j]!.trim().startsWith("|"); j++) {
      const values = cells(lines[j]!);
      const url = httpUrl(values[urlIndex]);
      if (url === undefined || values.length !== header.length) { invalid = true; break; }
      const value = (name: string) => values[header.indexOf(name)] || "unknown";
      rows.push({ url, claim: values[claimIndex]!, limitation: values[limitationIndex]!,
        published: value("published/revised"), retrieved: value("retrieved"), access: value("access") });
      end += lines[j]!.length + 1;
      if (end - start > MAX_TABLE_CHARS) { invalid = true; break; }
    }
    if (!invalid && rows.length) return { rows, start, end };
    offset += lines[i]!.length + 1;
  }
  return undefined;
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 600) return undefined;
  try { const url = new URL(value); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined; url.hash = ""; return url.href; } catch { return undefined; }
}
export function researchCitationUrls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>"'`\[\]{}|]+/giu)].flatMap((match) => {
    let value = match[0].replace(/[.,;:!?]+$/u, "");
    // Remove Markdown's closing delimiter, preserving balanced parentheses in
    // actual URLs (for example EU publication filenames).
    let excess = (value.match(/\)/gu)?.length ?? 0) - (value.match(/\(/gu)?.length ?? 0);
    while (excess > 0 && value.endsWith(")")) { value = value.slice(0, -1); excess--; }
    const url = httpUrl(value); return url === undefined ? [] : [url];
  });
}

function observedSources(executions: readonly ToolExecutionRecord[], now: Date): Map<string, Omit<SourceRow, "claim" | "limitation">> {
  const sources = new Map<string, Omit<SourceRow, "claim" | "limitation">>();
    for (const execution of executions) {
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
          ? source.retrievedAt.slice(0, 10) : execution.readReuseOf !== undefined ? previous?.retrieved ?? "unknown" : now.toISOString().slice(0, 10);
        sources.set(url, { url, published: date ?? previous?.published ?? "unknown", retrieved: retrievedAt,
          access: extracted ? "extracted; full text unverified" : previous?.access ?? "snippet; full text unavailable" });
      }
    }
  return sources;
}

/** Foreground research uses the same observed-URL and bounded claim-table contract. */
export function groundForegroundResearch(text: string, executions: readonly ToolExecutionRecord[], now: Date): { text?: string; failure?: string } {
  const table = parseTable(text);
  const cited = [...new Set(researchCitationUrls(text))];
  if (cited.length === 0) return { failure: "source-citations-missing" };
  const sources = observedSources(executions, now);
  if (cited.some(url => !sources.has(url))) return { failure: "unobserved-source" };
  const rows = cited.map(url => table?.rows.find(row => row.url === url) ?? { url, claim: "See cited narrative; claim support requires review", limitation: "Source provenance verified; factual support requires review" });
  const rendered = [SOURCE_HEADER, "| --- | --- | --- | --- | --- | --- |", ...rows.map((row) => {
    const source = sources.get(row.url)!;
    return `| ${row.url} | ${source.published} | ${source.retrieved} | ${source.access} | ${row.claim.replace(/\|/gu, "\\|")} | ${row.limitation.replace(/\|/gu, "\\|")} |`;
  })].join("\n");
  if (rendered.length > MAX_TABLE_CHARS) return { failure: "source-notes-limit" };
  return { text: table === undefined ? `${text}\n\n${rendered}` : text.slice(0, table.start) + rendered + text.slice(table.end) };
}
