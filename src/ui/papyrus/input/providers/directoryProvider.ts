import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  normalizeSuggestionProviderResult,
  type SuggestionItem,
  type SuggestionProvider,
  type SuggestionProviderError,
  type SuggestionTokenContext,
} from "../suggestionTypes.js";

export const DIRECTORY_SUGGESTION_PROVIDER_ID = "directory";
export const DEFAULT_DIRECTORY_PROVIDER_MAX_ENTRIES = 100;
export const DEFAULT_DIRECTORY_PROVIDER_MAX_SUGGESTIONS = 20;

export type DirectoryProviderEntry = {
  readonly name: string;
  readonly kind: "directory" | "file" | "other";
};

export type DirectoryProviderFileSystem = {
  readonly readdir: (
    path: string,
    options: {
      readonly limit: number;
      readonly signal?: AbortSignal;
    }
  ) => readonly DirectoryProviderEntry[] | Promise<readonly DirectoryProviderEntry[]>;
};

export type DirectorySuggestionMetadata = {
  readonly name: string;
  readonly baseToken: string;
  readonly isDirectory: true;
};

export type DirectorySuggestionProviderOptions = {
  readonly fs: DirectoryProviderFileSystem;
  readonly cwd: string;
  readonly workspaceRoot?: string;
  readonly homeDir?: string;
  readonly allowHomeExpansion?: boolean;
  readonly maxEntriesToRead?: number;
  readonly maxSuggestions?: number;
};

export function createDirectorySuggestionProvider(
  options: DirectorySuggestionProviderOptions
): SuggestionProvider<DirectorySuggestionMetadata> {
  const maxEntriesToRead = positiveIntegerOrDefault(
    options.maxEntriesToRead,
    DEFAULT_DIRECTORY_PROVIDER_MAX_ENTRIES
  );
  const maxSuggestions = positiveIntegerOrDefault(
    options.maxSuggestions,
    DEFAULT_DIRECTORY_PROVIDER_MAX_SUGGESTIONS
  );

  return {
    id: DIRECTORY_SUGGESTION_PROVIDER_ID,
    name: "Directories",
    capabilityTags: ["filesystem", "directory"],
    getSuggestions: async (context, signal) => {
      if (isSignalAborted(signal)) {
        return normalizeSuggestionProviderResult(DIRECTORY_SUGGESTION_PROVIDER_ID, { canceled: true });
      }

      const pathQuery = parseDirectoryToken(context.token, options);
      if (pathQuery === undefined) {
        return normalizeSuggestionProviderResult(DIRECTORY_SUGGESTION_PROVIDER_ID);
      }

      if (!isInsideWorkspace(pathQuery.baseDirectory, options.workspaceRoot)) {
        return normalizeSuggestionProviderResult(DIRECTORY_SUGGESTION_PROVIDER_ID);
      }

      try {
        const entries = await options.fs.readdir(pathQuery.baseDirectory, {
          limit: maxEntriesToRead,
          signal,
        });
        if (isSignalAborted(signal)) {
          return normalizeSuggestionProviderResult(DIRECTORY_SUGGESTION_PROVIDER_ID, { canceled: true });
        }

        const suggestions = entries
          .slice(0, maxEntriesToRead)
          .filter((entry) => entry.kind === "directory")
          .filter((entry) => pathQuery.includeHidden || !entry.name.startsWith("."))
          .filter((entry) => entry.name.startsWith(pathQuery.prefix))
          .filter((entry) => isInsideWorkspace(resolve(pathQuery.baseDirectory, entry.name), options.workspaceRoot))
          .slice(0, maxSuggestions)
          .map((entry) => toDirectorySuggestion(entry, pathQuery, context));

        return normalizeSuggestionProviderResult(DIRECTORY_SUGGESTION_PROVIDER_ID, { suggestions });
      } catch (error) {
        if (isNonDirectoryError(error)) {
          return normalizeSuggestionProviderResult(DIRECTORY_SUGGESTION_PROVIDER_ID);
        }
        return normalizeSuggestionProviderResult(DIRECTORY_SUGGESTION_PROVIDER_ID, {
          error: providerError(error),
        });
      }
    },
  };
}

type DirectoryPathQuery = {
  readonly baseToken: string;
  readonly replacementPrefix: string;
  readonly prefix: string;
  readonly baseDirectory: string;
  readonly includeHidden: boolean;
};

function parseDirectoryToken(
  token: string,
  options: DirectorySuggestionProviderOptions
): DirectoryPathQuery | undefined {
  if (!isPathLikeToken(token)) return undefined;
  if (isAbsolute(token)) return undefined;

  const tokenParts = splitToken(token);
  const baseDirectory = resolveBaseDirectory(tokenParts.baseToken, options);
  if (baseDirectory === undefined) return undefined;

  return {
    ...tokenParts,
    baseDirectory,
    includeHidden: tokenParts.prefix.startsWith("."),
  };
}

function isPathLikeToken(token: string): boolean {
  return token.startsWith("./")
    || token.startsWith("../")
    || token === "."
    || token === ".."
    || token.startsWith("~/")
    || token.includes("/");
}

function splitToken(token: string): {
  readonly baseToken: string;
  readonly replacementPrefix: string;
  readonly prefix: string;
} {
  if (token.endsWith("/")) {
    return {
      baseToken: token,
      replacementPrefix: token,
      prefix: "",
    };
  }

  const rawBase = dirname(token);
  const prefix = basename(token);
  const baseToken = rawBase === "." ? "" : `${rawBase}/`;
  return {
    baseToken,
    replacementPrefix: baseToken,
    prefix,
  };
}

function resolveBaseDirectory(
  baseToken: string,
  options: DirectorySuggestionProviderOptions
): string | undefined {
  if (baseToken.startsWith("~/")) {
    if (options.allowHomeExpansion !== true || options.homeDir === undefined) return undefined;
    return resolve(options.homeDir, baseToken.slice(2));
  }

  return resolve(options.cwd, baseToken || ".");
}

function toDirectorySuggestion(
  entry: DirectoryProviderEntry,
  pathQuery: DirectoryPathQuery,
  context: SuggestionTokenContext
): SuggestionItem<DirectorySuggestionMetadata> {
  const replacementText = `${pathQuery.replacementPrefix}${entry.name}/`;
  return {
    id: `${DIRECTORY_SUGGESTION_PROVIDER_ID}:${replacementText}`,
    label: `${entry.name}/`,
    replacementText,
    replacementRange: context.tokenRange,
    providerId: DIRECTORY_SUGGESTION_PROVIDER_ID,
    kind: "directory",
    metadata: {
      name: entry.name,
      baseToken: pathQuery.baseToken,
      isDirectory: true,
    },
  };
}

function isInsideWorkspace(path: string, workspaceRoot: string | undefined): boolean {
  if (workspaceRoot === undefined) return true;
  const resolvedRoot = resolve(workspaceRoot);
  const resolvedPath = resolve(path);
  const pathRelativeToRoot = relative(resolvedRoot, resolvedPath);
  return pathRelativeToRoot === ""
    || (!pathRelativeToRoot.startsWith("..") && !pathRelativeToRoot.startsWith(`${sep}..`) && !isAbsolute(pathRelativeToRoot));
}

function isNonDirectoryError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { readonly code?: unknown }).code === "ENOTDIR";
}

function providerError(error: unknown): SuggestionProviderError {
  if (error instanceof Error) {
    const code = "code" in error && typeof (error as { readonly code?: unknown }).code === "string"
      ? (error as { readonly code: string }).code
      : undefined;
    return {
      message: error.message,
      code,
      recoverable: true,
    };
  }
  return {
    message: String(error),
    recoverable: true,
  };
}

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
