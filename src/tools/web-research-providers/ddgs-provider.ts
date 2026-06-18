import { spawn } from "node:child_process";
import { DDGS_CAPABILITY_ID } from "../../python-env/capability-registry.js";
import { boundDiagnostic } from "../../python-env/diagnostics.js";
import type {
  ProviderAvailability,
  WebResearchProvider,
  WebResearchPythonCapabilityPathResolver,
  WebResearchPythonCapabilityStatusChecker,
  WebResearchSubprocessSpawn,
  WebSearchResult
} from "../web-research-provider.js";
import {
  defaultWebResearchPythonCapabilityPathResolver,
  defaultWebResearchPythonCapabilityStatusChecker
} from "../web-research-provider.js";

const DDGS_SETUP_HINT = "estacoda python-env setup ddgs";
const DDGS_SEARCH_TIMEOUT_MS = 30_000;
const DDGS_STDOUT_LIMIT_CHARS = 1_000_000;
const DDGS_DIAGNOSTIC_LIMIT_CHARS = 1_200;

const DDGS_SEARCH_SCRIPT = String.raw`
import json
import sys
from ddgs import DDGS

payload = json.load(sys.stdin)
query = str(payload.get("query", ""))
limit = int(payload.get("limit", 10))
results = []
for result in DDGS().text(query, max_results=limit):
    if isinstance(result, dict):
        results.append({
            "title": result.get("title"),
            "href": result.get("href"),
            "url": result.get("url"),
            "body": result.get("body"),
            "description": result.get("description"),
        })
    if len(results) >= limit:
        break
json.dump({"results": results}, sys.stdout, ensure_ascii=False)
`;

type DdgsProviderOptions = {
  pythonStateRoot?: string;
  capabilityStatusChecker?: WebResearchPythonCapabilityStatusChecker;
  capabilityPathResolver?: WebResearchPythonCapabilityPathResolver;
  spawnProcess?: WebResearchSubprocessSpawn;
  timeoutMs?: number;
};

type DdgsSearchResponse = {
  results?: unknown;
};

export const ddgsProvider: WebResearchProvider = createDdgsProvider();

function createDdgsProvider(options: DdgsProviderOptions = {}): WebResearchProvider {
  const capabilityStatusChecker = options.capabilityStatusChecker ?? defaultWebResearchPythonCapabilityStatusChecker();
  const capabilityPathResolver = options.capabilityPathResolver ?? defaultWebResearchPythonCapabilityPathResolver();
  const spawnProcess = options.spawnProcess ?? (spawn as WebResearchSubprocessSpawn);
  const timeoutMs = options.timeoutMs ?? DDGS_SEARCH_TIMEOUT_MS;

  return {
    name: "ddgs",
    displayName: "DDGS",
    capabilities: { search: true },
    configure: (context) => createDdgsProvider({
      pythonStateRoot: context.pythonStateRoot,
      capabilityStatusChecker: context.pythonCapabilityStatusChecker ?? defaultWebResearchPythonCapabilityStatusChecker(),
      capabilityPathResolver: context.pythonCapabilityPathResolver ?? defaultWebResearchPythonCapabilityPathResolver(),
      spawnProcess: context.subprocessSpawn
    }),
    getAvailability: async () => ddgsAvailability({
      pythonStateRoot: options.pythonStateRoot,
      capabilityStatusChecker
    }),
    search: async (query, searchOptions) => {
      const availability = await ddgsAvailability({
        pythonStateRoot: options.pythonStateRoot,
        capabilityStatusChecker
      });
      if (!availability.available) {
        throw new Error(`DDGS search is unavailable: ${availability.reason ?? `Run ${DDGS_SETUP_HINT}`}`);
      }
      if (options.pythonStateRoot === undefined) {
        throw new Error(`DDGS search is unavailable: Run ${DDGS_SETUP_HINT}`);
      }

      const paths = capabilityPathResolver({
        stateRoot: options.pythonStateRoot,
        capabilityId: DDGS_CAPABILITY_ID
      });
      const stdout = await runDdgsSearchSubprocess({
        pythonPath: paths.pythonPath,
        query,
        limit: normalizeLimit(searchOptions?.maxResults),
        signal: searchOptions?.signal,
        spawnProcess,
        timeoutMs
      });
      return mapDdgsResults(parseDdgsResponse(stdout));
    }
  };
}

async function ddgsAvailability(input: {
  pythonStateRoot?: string;
  capabilityStatusChecker: WebResearchPythonCapabilityStatusChecker;
}): Promise<ProviderAvailability> {
  if (input.pythonStateRoot === undefined) {
    return unavailable("Managed Python state is not available for DDGS search.");
  }

  const status = await input.capabilityStatusChecker({
    stateRoot: input.pythonStateRoot,
    capabilityId: DDGS_CAPABILITY_ID
  });
  if (!status.ok) {
    return unavailable(status.message);
  }
  if (status.status !== "installed" && status.status !== "verified") {
    return unavailable("DDGS managed Python capability is not ready.");
  }
  return { available: true };
}

function unavailable(reason: string): ProviderAvailability {
  return {
    available: false,
    reason: `${reason} Run ${DDGS_SETUP_HINT}.`
  };
}

async function runDdgsSearchSubprocess(input: {
  pythonPath: string;
  query: string;
  limit: number;
  signal?: AbortSignal;
  spawnProcess: WebResearchSubprocessSpawn;
  timeoutMs: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = input.spawnProcess(input.pythonPath, ["-c", DDGS_SEARCH_SCRIPT], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let timer: ReturnType<typeof setTimeout>;

    const cleanup = () => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const fail = (message: string) => settle(() => reject(new Error(message)));
    const killAndFail = (message: string) => {
      child.kill();
      fail(message);
    };
    timer = setTimeout(() => {
      killAndFail("DDGS search timed out.");
    }, input.timeoutMs);
    const onAbort = () => {
      killAndFail("DDGS search was aborted.");
    };

    if (input.signal?.aborted === true) {
      onAbort();
      return;
    }
    input.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk, DDGS_STDOUT_LIMIT_CHARS);
    });
    child.stderr.on("data", (chunk) => {
      stderr = boundDiagnostic(`${stderr}${String(chunk)}`, DDGS_DIAGNOSTIC_LIMIT_CHARS);
    });
    child.on("error", () => {
      fail("DDGS subprocess failed to start.");
    });
    child.on("close", (code) => {
      if (code === 0) {
        settle(() => resolve(stdout));
        return;
      }
      const diagnostic = stderr.length === 0 ? "No diagnostic output was captured." : stderr;
      fail(`DDGS subprocess failed with exit code ${code ?? "unknown"}: ${boundDiagnostic(diagnostic, DDGS_DIAGNOSTIC_LIMIT_CHARS)}`);
    });

    child.stdin.write(JSON.stringify({
      query: input.query,
      limit: input.limit
    }));
    child.stdin.end();
  });
}

function parseDdgsResponse(stdout: string): DdgsSearchResponse {
  try {
    return JSON.parse(stdout) as DdgsSearchResponse;
  } catch {
    throw new Error("DDGS search returned invalid JSON.");
  }
}

function mapDdgsResults(response: DdgsSearchResponse): WebSearchResult[] {
  if (!Array.isArray(response.results)) {
    throw new Error("DDGS search response was malformed.");
  }
  if (response.results.length === 0) {
    return [];
  }

  const mapped = response.results
    .filter(isRecord)
    .map((result): WebSearchResult | undefined => {
      if (typeof result.title !== "string") {
        return undefined;
      }
      const url = typeof result.href === "string"
        ? result.href
        : typeof result.url === "string"
          ? result.url
          : undefined;
      if (url === undefined) {
        return undefined;
      }

      const mappedResult: WebSearchResult = {
        title: result.title,
        url
      };
      if (typeof result.body === "string") {
        mappedResult.snippet = result.body;
      } else if (typeof result.description === "string") {
        mappedResult.snippet = result.description;
      }
      return mappedResult;
    })
    .filter((result): result is WebSearchResult => result !== undefined);

  if (mapped.length === 0) {
    throw new Error("DDGS search response contained malformed results.");
  }

  return mapped;
}

function normalizeLimit(maxResults: number | undefined): number {
  if (maxResults === undefined || !Number.isFinite(maxResults)) {
    return 10;
  }
  return Math.max(1, Math.min(Math.trunc(maxResults), 20));
}

function appendBounded(current: string, chunk: unknown, maxChars: number): string {
  const next = `${current}${String(chunk)}`;
  return next.length <= maxChars ? next : next.slice(0, maxChars);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
