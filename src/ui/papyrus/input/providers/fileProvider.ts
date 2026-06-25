import {
  normalizeSuggestionProviderResult,
  type SuggestionItem,
  type SuggestionProvider,
} from "../suggestionTypes.js";

export const FILE_SUGGESTION_PROVIDER_ID = "file";

export type FileSuggestionMetadata = {
  readonly deferred: true;
};

export type FileSuggestionProviderOptions = {
  readonly reason?: string;
};

export function createFileSuggestionProvider(
  options: FileSuggestionProviderOptions = {}
): SuggestionProvider<FileSuggestionMetadata> {
  return {
    id: FILE_SUGGESTION_PROVIDER_ID,
    name: "Files",
    capabilityTags: ["filesystem", "file"],
    getSuggestions: (context, signal) => {
      if (signal?.aborted === true) {
        return normalizeSuggestionProviderResult(FILE_SUGGESTION_PROVIDER_ID, { canceled: true });
      }

      const reason = options.reason ?? "File suggestions are deferred until a bounded file index provider is implemented.";
      const item: SuggestionItem<FileSuggestionMetadata> = {
        id: `${FILE_SUGGESTION_PROVIDER_ID}:deferred`,
        label: "File suggestions unavailable",
        description: reason,
        replacementText: context.token,
        replacementRange: context.tokenRange,
        providerId: FILE_SUGGESTION_PROVIDER_ID,
        kind: "file",
        availability: {
          state: "unavailable",
          reason,
        },
        metadata: {
          deferred: true,
        },
      };

      return normalizeSuggestionProviderResult(FILE_SUGGESTION_PROVIDER_ID, {
        suggestions: [item],
      });
    },
  };
}
