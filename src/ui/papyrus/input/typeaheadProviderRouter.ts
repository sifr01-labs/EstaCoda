import {
  createSlashSuggestionTokenContext,
  SLASH_COMMAND_SUGGESTION_PROVIDER_ID,
} from "./providers/slashCommandProvider.js";
import type {
  SuggestionProvider,
  SuggestionTokenContext,
} from "./suggestionTypes.js";

export type TypeaheadProviderRouteInput = {
  readonly input: string;
  readonly cursorOffset: number;
};

export type TypeaheadProviderSelection<TMetadata = unknown> = {
  readonly triggerKind: SuggestionTokenContext["triggerKind"];
  readonly context: SuggestionTokenContext;
  readonly provider: SuggestionProvider<TMetadata>;
};

export type TypeaheadProviderRouter<TMetadata = unknown> = {
  route(input: TypeaheadProviderRouteInput): TypeaheadProviderSelection<TMetadata> | undefined;
};

export type TypeaheadProviderRouterOptions<TMetadata = unknown> = {
  readonly providers: readonly SuggestionProvider<TMetadata>[];
};

export function createTypeaheadProviderRouter<TMetadata = unknown>(
  options: TypeaheadProviderRouterOptions<TMetadata>
): TypeaheadProviderRouter<TMetadata> {
  const providersById = new Map(options.providers.map((provider) => [provider.id, provider]));

  return {
    route(input) {
      const slashContext = createSlashSuggestionTokenContext(input.input, input.cursorOffset);
      if (slashContext !== undefined) {
        const provider = providersById.get(SLASH_COMMAND_SUGGESTION_PROVIDER_ID);
        if (provider !== undefined) {
          return {
            triggerKind: "slash",
            context: slashContext,
            provider,
          };
        }
      }

      return undefined;
    },
  };
}
