import {
  normalizeSuggestionProviderResult,
  type SuggestionItem,
  type SuggestionProvider,
  type SuggestionProviderError,
  type SuggestionTokenContext,
} from "../suggestionTypes.js";

export const MCP_RESOURCE_SUGGESTION_PROVIDER_ID = "mcp-resource";
export const DEFAULT_MCP_RESOURCE_MAX_RESOURCES = 200;
export const DEFAULT_MCP_RESOURCE_MAX_SUGGESTIONS = 20;

export type McpResourceListOptions = {
  readonly limit: number;
  readonly signal?: AbortSignal;
};

export type McpResourceSuggestionSource = {
  readonly listResources: (
    options: McpResourceListOptions
  ) => readonly McpResourceSuggestionResource[] | Promise<readonly McpResourceSuggestionResource[]>;
};

export type McpResourceSuggestionResource = {
  readonly label: string;
  readonly uri?: string;
  readonly description?: string;
  readonly detail?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

export type McpResourceSuggestionMetadata = {
  readonly label: string;
  readonly uri?: string;
  readonly description?: string;
  readonly detail?: string;
  readonly resourceIndex: number;
  readonly matchKind: McpResourceMatchKind;
  readonly sourceMetadata?: Readonly<Record<string, unknown>>;
};

export type McpResourceSuggestionProviderOptions = {
  readonly source: McpResourceSuggestionSource;
  readonly enabled?: boolean;
  readonly isAuthorized?: () => boolean | Promise<boolean>;
  readonly maxResourcesToScan?: number;
  readonly maxSuggestions?: number;
};

type McpResourceMatchKind = "exact" | "prefix" | "contains" | "subsequence";

type RankedMcpResource = {
  readonly resource: McpResourceSuggestionResource;
  readonly resourceIndex: number;
  readonly score: number;
  readonly matchKind: McpResourceMatchKind;
};

export function createMcpResourceSuggestionProvider(
  options: McpResourceSuggestionProviderOptions
): SuggestionProvider<McpResourceSuggestionMetadata> {
  const maxResourcesToScan = positiveIntegerOrDefault(
    options.maxResourcesToScan,
    DEFAULT_MCP_RESOURCE_MAX_RESOURCES
  );
  const maxSuggestions = positiveIntegerOrDefault(
    options.maxSuggestions,
    DEFAULT_MCP_RESOURCE_MAX_SUGGESTIONS
  );

  return {
    id: MCP_RESOURCE_SUGGESTION_PROVIDER_ID,
    name: "MCP resources",
    capabilityTags: ["mcp", "resource"],
    getSuggestions: async (context, signal) => {
      if (isSignalAborted(signal)) {
        return normalizeSuggestionProviderResult(MCP_RESOURCE_SUGGESTION_PROVIDER_ID, { canceled: true });
      }
      if (options.enabled !== true) {
        return normalizeSuggestionProviderResult(MCP_RESOURCE_SUGGESTION_PROVIDER_ID);
      }

      try {
        const authorized = await options.isAuthorized?.();
        if (authorized !== true) {
          return normalizeSuggestionProviderResult(MCP_RESOURCE_SUGGESTION_PROVIDER_ID);
        }
        if (isSignalAborted(signal)) {
          return normalizeSuggestionProviderResult(MCP_RESOURCE_SUGGESTION_PROVIDER_ID, { canceled: true });
        }

        const resources = await options.source.listResources({ limit: maxResourcesToScan, signal });
        if (isSignalAborted(signal)) {
          return normalizeSuggestionProviderResult(MCP_RESOURCE_SUGGESTION_PROVIDER_ID, { canceled: true });
        }

        const suggestions = rankMcpResources({
          resources: resources.slice(0, maxResourcesToScan),
          context,
        })
          .slice(0, maxSuggestions)
          .map((resource) => toMcpResourceSuggestion(resource, context));

        return normalizeSuggestionProviderResult(MCP_RESOURCE_SUGGESTION_PROVIDER_ID, { suggestions });
      } catch (error) {
        return normalizeSuggestionProviderResult(MCP_RESOURCE_SUGGESTION_PROVIDER_ID, {
          error: providerError(error),
        });
      }
    },
  };
}

function rankMcpResources(input: {
  readonly resources: readonly McpResourceSuggestionResource[];
  readonly context: SuggestionTokenContext;
}): readonly RankedMcpResource[] {
  const seenLabels = new Set<string>();
  const query = normalizeSearchText(input.context.token);
  const ranked: RankedMcpResource[] = [];

  for (const [resourceIndex, rawResource] of input.resources.entries()) {
    const label = rawResource.label.trim();
    const duplicateKey = normalizeSearchText(label);
    if (label.length === 0 || seenLabels.has(duplicateKey)) continue;
    seenLabels.add(duplicateKey);

    const resource = {
      ...rawResource,
      label,
    };
    const match = scoreMcpResource(resource, query);
    if (match === undefined) continue;
    ranked.push({
      resource,
      resourceIndex,
      score: match.score,
      matchKind: match.kind,
    });
  }

  return ranked.sort((left, right) => left.score - right.score || left.resourceIndex - right.resourceIndex);
}

function toMcpResourceSuggestion(
  ranked: RankedMcpResource,
  context: SuggestionTokenContext
): SuggestionItem<McpResourceSuggestionMetadata> {
  const { resource } = ranked;
  return {
    id: `${MCP_RESOURCE_SUGGESTION_PROVIDER_ID}:${ranked.resourceIndex}`,
    label: resource.label,
    detail: resource.detail ?? resource.uri,
    description: resource.description,
    replacementText: resource.label,
    replacementRange: context.tokenRange,
    providerId: MCP_RESOURCE_SUGGESTION_PROVIDER_ID,
    kind: "mcp",
    rank: {
      score: ranked.score,
    },
    metadata: {
      label: resource.label,
      uri: resource.uri,
      description: resource.description,
      detail: resource.detail,
      resourceIndex: ranked.resourceIndex,
      matchKind: ranked.matchKind,
      sourceMetadata: resource.metadata,
    },
  };
}

function scoreMcpResource(
  resource: McpResourceSuggestionResource,
  query: string
): { readonly kind: McpResourceMatchKind; readonly score: number } | undefined {
  if (query.length === 0) return { kind: "prefix", score: 1 };

  const fields = [
    resource.label,
    resource.uri,
    resource.description,
    resource.detail,
  ].flatMap((field) => field === undefined ? [] : [normalizeSearchText(field)]);

  if (fields.some((field) => field === query)) return { kind: "exact", score: 0 };
  if (fields.some((field) => field.startsWith(query))) return { kind: "prefix", score: 1 };
  if (fields.some((field) => field.includes(query))) return { kind: "contains", score: 2 };
  if (fields.some((field) => isSubsequence(field, query))) return { kind: "subsequence", score: 3 };
  return undefined;
}

function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function isSubsequence(text: string, query: string): boolean {
  let queryIndex = 0;
  for (const char of text) {
    if (char === query[queryIndex]) queryIndex += 1;
    if (queryIndex === query.length) return true;
  }
  return false;
}

function providerError(error: unknown): SuggestionProviderError {
  if (error instanceof Error) return { message: error.message, recoverable: true };
  return { message: String(error), recoverable: true };
}

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
