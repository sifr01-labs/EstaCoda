import { createHash } from "node:crypto";
import type { ExecutionCheckpointResource, ForegroundExecutionCheckpoint } from "../contracts/execution-checkpoint.js";
import { EXECUTION_CHECKPOINT_MAX_RESOURCES } from "../contracts/execution-checkpoint.js";
import type { RegisteredTool, ToolResult } from "../contracts/tool.js";
import { browserContinuityUrl } from "../browser/continuity-url.js";
import { sanitizeCheckpointText, validateExecutionCheckpoint } from "../session/execution-checkpoint-state.js";
import { checkpointSafeFactsFromResult } from "./execution-checkpoint-journal.js";

/** Relate only runtime-observed source locators and reviewed connector receipts.
 * No unexecuted arguments, name matching, current-tab guesses or generic result scraping. */
export function checkpointResourcesFromResult(input: {
  checkpoint: ForegroundExecutionCheckpoint;
  tool: RegisteredTool;
  result: ToolResult;
  observedAt: string;
  operationId?: string;
  /** Input of the successful connector call, used only to anchor returned task IDs. */
  acceptedInput?: Record<string, unknown>;
}): ExecutionCheckpointResource[] {
  const resources = structuredClone(input.checkpoint.resources ?? []);
  if (!input.result.ok) return resources;
  const metadata = input.result.metadata;
  const admit = (resource: ExecutionCheckpointResource): void => {
    const index = resources.findIndex((entry) => entry.id === resource.id);
    if (index < 0 && resources.length >= EXECUTION_CHECKPOINT_MAX_RESOURCES) return;
    const candidate = resources.slice();
    if (index < 0) candidate.push(resource); else candidate[index] = resource;
    // One oversized observation must not erase earlier rows or fail the tool.
    try { validateExecutionCheckpoint({ ...input.checkpoint, resources: candidate }); } catch { return; }
    resources.splice(0, resources.length, ...candidate);
  };
  if (input.tool.name === "browser.extract" && input.tool.toolsets.includes("browser")) {
    const links = metadata?.links;
    if (Array.isArray(links)) for (const link of links.slice(0, EXECUTION_CHECKPOINT_MAX_RESOURCES)) {
      if (record(link)) {
        const resource = sourceResource(link.href, link.text, "browser.extract");
        if (resource !== undefined && !resources.some((entry) => entry.sourceUrl === resource.sourceUrl)) admit(resource);
      }
    }
  }
  if (input.tool.name === "browser.download" && input.tool.toolsets.includes("browser") &&
    metadata?.outcome === "download-completed") {
    const pageUrl = browserContinuityUrl(metadata.pageUrl);
    const resource = resources.find((entry) => entry.sourceUrl === pageUrl) ??
      sourceResource(pageUrl, metadata.filename, "browser.download");
    if (resource !== undefined && typeof metadata.artifactId === "string" && typeof metadata.sha256 === "string" &&
      !resource.artifactReferences.some((entry) => entry.id === metadata.artifactId)) {
      admit({ ...resource, artifactReferences: [...resource.artifactReferences, { id: metadata.artifactId, sha256: metadata.sha256 }] });
    }
  }
  if (input.tool.connector === undefined) return resources;
  const facts = checkpointSafeFactsFromResult(input);
  const destinations = facts.filter((fact) => ["specification_id", "collection_id", "resource_id", "task_id"].includes(fact.kind));
  // Bulk results without per-item provenance must not be cross-wired into a row.
  if (destinations.some((fact) => destinations.filter((other) => other.kind === fact.kind).length > 1)) return resources;
  const artifactIds = facts.filter((fact) => fact.kind === "artifact_id");
  const hashes = facts.filter((fact) => fact.kind === "artifact_hash");
  let candidates: ExecutionCheckpointResource[];
  if (artifactIds.length > 0 || hashes.length > 0) {
    if (artifactIds.length !== 1 || hashes.length !== 1) return resources;
    candidates = resources.filter((resource) => resource.artifactReferences.some((artifact) =>
      artifact.id === artifactIds[0]!.value && artifact.sha256 === hashes[0]!.value));
  } else {
    const anchors = destinations.map((fact) => resources.filter((resource) => resource.destinationFacts.some((known) =>
      known.kind === fact.kind && known.value === fact.value && known.connectorId === fact.connectorId)))
      .filter((matches) => matches.length > 0);
    // A returned task handle belongs to the exact, already-grounded destination
    // used by this successful call. Never associate by a label or workspace.
    if (destinations.some((fact) => fact.kind === "task_id")) {
      for (const [field, kind] of Object.entries({ specId: "specification_id", specificationId: "specification_id", collectionId: "collection_id", resourceId: "resource_id" })) {
        const value = input.acceptedInput?.[field];
        if (typeof value !== "string") continue;
        anchors.push(resources.filter((resource) => resource.destinationFacts.some((known) =>
          known.kind === kind && known.value === value && known.connectorId === input.tool.connector!.id)));
      }
    }
    candidates = anchors.length === 0 ? [] : resources.filter((resource) => anchors.every((matches) => matches.includes(resource)));
  }
  if (candidates.length !== 1) return resources;
  const resource = candidates[0]!;
  const additions = destinations.filter((fact) => !resource.destinationFacts.some((known) =>
    known.kind === fact.kind && known.value === fact.value && known.connectorId === fact.connectorId));
  admit({
    ...resource,
    destinationFacts: [...resource.destinationFacts, ...additions],
    operationIds: input.operationId === undefined || resource.operationIds.includes(input.operationId)
      ? resource.operationIds : [...resource.operationIds, input.operationId]
  });
  return resources;
}

function sourceResource(url: unknown, label: unknown, sourceTool: ExecutionCheckpointResource["sourceTool"]): ExecutionCheckpointResource | undefined {
  const sourceUrl = browserContinuityUrl(url);
  if (sourceUrl === undefined || typeof label !== "string") return undefined;
  const name = sanitizeCheckpointText(label, 160);
  if (name.length === 0 || name.includes("[REDACTED")) return undefined;
  return {
    id: `resource:${createHash("sha256").update(sourceUrl).digest("hex").slice(0, 24)}`,
    name, sourceUrl, sourceTool, artifactReferences: [], destinationFacts: [], operationIds: []
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
