import type { ResolvedAuxiliaryRoute, ResolvedModelRoute } from "../contracts/provider.js";
import type { SessionMessage } from "../contracts/session.js";
import { executeAuxiliaryTask, type AuxiliaryExecutionResult } from "../providers/auxiliary-executor.js";
import type { ProviderExecutor } from "../providers/provider-executor.js";
import { redactSensitiveText } from "../utils/redaction.js";
import {
  evidenceSpanExists,
  normalizeExtractedFact,
  type ExtractedFact
} from "./extracted-fact.js";

export type MemoryFactExtractionResult = {
  facts: ExtractedFact[];
  diagnostics: {
    ok: boolean;
    routeSource: "semantic-compression" | "primary" | "unavailable";
    fallbackUsed: boolean;
    rawFactCount: number;
    acceptedFactCount: number;
    rejectedFactCount: number;
    warnings: string[];
  };
};

export type MemoryFactExtractorOptions = {
  route?: ResolvedAuxiliaryRoute;
  mainRoute?: ResolvedModelRoute;
  providerExecutor?: Pick<ProviderExecutor, "complete">;
  id?: () => string;
};

export async function extractMemoryFacts(input: {
  messages: readonly SessionMessage[];
  profileId: string;
  sessionId: string;
  options: MemoryFactExtractorOptions;
  signal?: AbortSignal;
}): Promise<MemoryFactExtractionResult> {
  const warnings: string[] = [];
  if (
    input.options.route === undefined ||
    input.options.mainRoute === undefined ||
    input.options.providerExecutor === undefined
  ) {
    return emptyResult({
      routeSource: "unavailable",
      warning: "memory fact extraction skipped because auxiliary route, main route, or provider executor is unavailable"
    });
  }

  const result = await executeAuxiliaryTask({
    route: input.options.route,
    mainRoute: input.options.mainRoute,
    providerExecutor: input.options.providerExecutor,
    request: {
      messages: [
        { role: "system", content: FACT_EXTRACTION_SYSTEM_PROMPT },
        { role: "user", content: renderExtractionRequest(input.messages) }
      ],
      temperature: 0,
      responseFormat: { type: "json_object" }
    },
    signal: input.signal,
    scopeKey: `${input.profileId}:${input.sessionId}`
  });

  if (!result.ok || result.response === undefined) {
    return failedResult(result);
  }

  const parsed = parseFactPayload(result.response.content, warnings);
  const normalized = parsed.entries.flatMap((entry) => {
    const fact = normalizeExtractedFact(entry, input.options.id);
    return fact === undefined ? [] : [fact];
  });
  const facts = normalized.filter((fact) => evidenceSpanExists({
    fact,
    messages: input.messages.map((message) => ({ id: message.id, content: message.content }))
  }));

  return {
    facts,
    diagnostics: {
      ok: parsed.ok,
      routeSource: result.fallbackUsed ? "primary" : "semantic-compression",
      fallbackUsed: result.fallbackUsed,
      rawFactCount: parsed.entries.length,
      acceptedFactCount: facts.length,
      rejectedFactCount: Math.max(0, parsed.entries.length - facts.length),
      warnings
    }
  };
}

const FACT_EXTRACTION_SYSTEM_PROMPT = [
  "You extract durable facts from EstaCoda session transcripts.",
  "Return only JSON with a top-level facts array.",
  "Each fact must include statement, category, evidence, explicitness, sensitivity, and confidence.",
  "Do not decide whether to save facts.",
  "Do not include transient facts, secrets, sensitive attributes, or unsupported inferences.",
  "Evidence exactSpan must quote text that appears verbatim in the source message."
].join("\n");

function renderExtractionRequest(messages: readonly SessionMessage[]): string {
  return [
    "Extract durable, future-useful facts from this transcript slice.",
    "Allowed categories: work, project, preference, operating-style, recurring-constraint, technical-default, personal, other.",
    "Allowed explicitness: explicit, strongly-implied, inferred.",
    "Allowed sensitivity: none, private, sensitive, secret.",
    "Return: {\"facts\":[{\"statement\":\"...\",\"category\":\"...\",\"evidence\":[{\"messageId\":\"...\",\"exactSpan\":\"...\"}],\"explicitness\":\"explicit\",\"sensitivity\":\"none\",\"confidence\":0.7}]}",
    "",
    "Transcript:",
    ...messages.map((message) => [
      `messageId: ${message.id}`,
      `role: ${message.role}`,
      "content:",
      message.content
    ].join("\n"))
  ].join("\n\n");
}

function parseFactPayload(content: string, warnings: string[]): { ok: boolean; entries: unknown[] } {
  const jsonText = extractJsonText(content);
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    if (Array.isArray(parsed)) {
      return { ok: true, entries: parsed };
    }
    if (isRecord(parsed) && Array.isArray(parsed.facts)) {
      return { ok: true, entries: parsed.facts };
    }
    warnings.push("memory fact extractor returned JSON without a facts array");
    return { ok: false, entries: [] };
  } catch (error) {
    warnings.push(`memory fact extractor returned invalid JSON: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`);
    return { ok: false, entries: [] };
  }
}

function extractJsonText(content: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(content);
  return (fenced?.[1] ?? content).trim();
}

function failedResult(result: AuxiliaryExecutionResult): MemoryFactExtractionResult {
  return {
    facts: [],
    diagnostics: {
      ok: false,
      routeSource: "unavailable",
      fallbackUsed: result.fallbackUsed,
      rawFactCount: 0,
      acceptedFactCount: 0,
      rejectedFactCount: 0,
      warnings: [
        `memory fact extraction failed: ${result.status}`,
        ...result.diagnostics.map((diagnostic) => redactSensitiveText(diagnostic))
      ]
    }
  };
}

function emptyResult(input: {
  routeSource: "semantic-compression" | "primary" | "unavailable";
  warning: string;
}): MemoryFactExtractionResult {
  return {
    facts: [],
    diagnostics: {
      ok: false,
      routeSource: input.routeSource,
      fallbackUsed: false,
      rawFactCount: 0,
      acceptedFactCount: 0,
      rejectedFactCount: 0,
      warnings: [input.warning]
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
