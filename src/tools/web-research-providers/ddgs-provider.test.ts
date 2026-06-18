import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi, afterEach } from "vitest";
import type { ManagedPythonCapabilityInstallStatus } from "../../python-env/capability-manager.js";
import { DDGS_CAPABILITY_ID } from "../../python-env/capability-registry.js";
import type { ManagedPythonCapabilityEnvManifest } from "../../python-env/manifest.js";
import type {
  WebResearchProvider,
  WebResearchProviderContext,
  WebResearchSubprocess,
  WebResearchSubprocessSpawn
} from "../web-research-provider.js";
import { ddgsProvider } from "./ddgs-provider.js";

class FakeChildProcess extends EventEmitter implements WebResearchSubprocess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);

  override on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  override on(event: "error", listener: (error: Error) => void): this;
  override on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }
}

describe("DDGS web research provider", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is unavailable when the managed Python state root is missing", async () => {
    const provider = configureDdgs();

    await expect(provider.getAvailability()).resolves.toEqual({
      available: false,
      reason: "Managed Python state is not available for DDGS search. Run estacoda python-env setup ddgs."
    });
  });

  it("is unavailable when capability status requires installation", async () => {
    const provider = configureDdgs({
      pythonStateRoot: "/state",
      status: {
        ok: false,
        capabilityId: DDGS_CAPABILITY_ID,
        reason: "install_required",
        message: "Managed Python capability environment has not been installed."
      }
    });

    await expect(provider.getAvailability()).resolves.toEqual({
      available: false,
      reason: "Managed Python capability environment has not been installed. Run estacoda python-env setup ddgs."
    });
  });

  it("is unavailable when capability verification/status fails", async () => {
    const provider = configureDdgs({
      pythonStateRoot: "/state",
      status: {
        ok: false,
        capabilityId: DDGS_CAPABILITY_ID,
        reason: "import_verify_failed",
        message: "Managed Python capability import verification failed."
      }
    });

    await expect(provider.getAvailability()).resolves.toMatchObject({
      available: false,
      reason: "Managed Python capability import verification failed. Run estacoda python-env setup ddgs."
    });
  });

  it("is available when capability status is installed or verified", async () => {
    await expect(configureDdgs({
      pythonStateRoot: "/state",
      status: installedStatus("installed")
    }).getAvailability()).resolves.toEqual({ available: true });
    await expect(configureDdgs({
      pythonStateRoot: "/state",
      status: installedStatus("verified")
    }).getAvailability()).resolves.toEqual({ available: true });
  });

  it("maps successful subprocess results to the web search result contract", async () => {
    const harness = createSpawnHarness({
      stdout: {
        results: [{
          title: "DDGS Result",
          href: "https://example.com/ddgs",
          body: "DDGS snippet",
          extra: "ignored"
        }]
      }
    });
    const provider = configureDdgs({
      pythonStateRoot: "/state",
      status: installedStatus("verified"),
      spawnProcess: harness.spawnProcess
    });

    await expect(provider.search?.("estacoda", { maxResults: 5 })).resolves.toEqual([{
      title: "DDGS Result",
      url: "https://example.com/ddgs",
      snippet: "DDGS snippet"
    }]);
  });

  it("uses href or url as URL and body or description as snippet", async () => {
    const harness = createSpawnHarness({
      stdout: {
        results: [
          {
            title: "Href Result",
            href: "https://example.com/href",
            description: "description fallback"
          },
          {
            title: "Url Result",
            url: "https://example.com/url",
            body: "body wins",
            description: "ignored description"
          }
        ]
      }
    });
    const provider = configureDdgs({
      pythonStateRoot: "/state",
      status: installedStatus("verified"),
      spawnProcess: harness.spawnProcess
    });

    await expect(provider.search?.("estacoda")).resolves.toEqual([
      {
        title: "Href Result",
        url: "https://example.com/href",
        snippet: "description fallback"
      },
      {
        title: "Url Result",
        url: "https://example.com/url",
        snippet: "body wins"
      }
    ]);
  });

  it("returns bounded diagnostics for subprocess failures", async () => {
    const stderr = `failure ${"x".repeat(2_000)}`;
    const harness = createSpawnHarness({
      stderr,
      exitCode: 1
    });
    const provider = configureDdgs({
      pythonStateRoot: "/state",
      status: installedStatus("verified"),
      spawnProcess: harness.spawnProcess
    });

    await expect(provider.search?.("estacoda")).rejects.toThrow(/DDGS subprocess failed with exit code 1: .*failure/u);
    await expect(provider.search?.("estacoda")).rejects.toThrow(/\[truncated\]/u);
  });

  it("handles malformed stdout", async () => {
    const harness = createSpawnHarness({
      rawStdout: "not json"
    });
    const provider = configureDdgs({
      pythonStateRoot: "/state",
      status: installedStatus("verified"),
      spawnProcess: harness.spawnProcess
    });

    await expect(provider.search?.("estacoda")).rejects.toThrow("DDGS search returned invalid JSON.");
  });

  it("handles malformed response and result shapes", async () => {
    await expect(configureDdgs({
      pythonStateRoot: "/state",
      status: installedStatus("verified"),
      spawnProcess: createSpawnHarness({ stdout: { nope: [] } }).spawnProcess
    }).search?.("estacoda")).rejects.toThrow("DDGS search response was malformed.");

    await expect(configureDdgs({
      pythonStateRoot: "/state",
      status: installedStatus("verified"),
      spawnProcess: createSpawnHarness({ stdout: { results: [{ title: 123, href: "https://example.com" }] } }).spawnProcess
    }).search?.("estacoda")).rejects.toThrow("DDGS search response contained malformed results.");
  });

  it("kills the subprocess on abort", async () => {
    const harness = createSpawnHarness({ keepOpen: true });
    const provider = configureDdgs({
      pythonStateRoot: "/state",
      status: installedStatus("verified"),
      spawnProcess: harness.spawnProcess
    });
    const controller = new AbortController();
    const search = provider.search?.("estacoda", { signal: controller.signal });

    controller.abort();

    await expect(search).rejects.toThrow("DDGS search was aborted.");
    expect(harness.children[0]?.kill).toHaveBeenCalledTimes(1);
  });

  it("kills the subprocess on timeout", async () => {
    vi.useFakeTimers();
    const harness = createSpawnHarness({ keepOpen: true });
    const provider = configureDdgs({
      pythonStateRoot: "/state",
      status: installedStatus("verified"),
      spawnProcess: harness.spawnProcess
    });
    const search = provider.search?.("estacoda");
    const expectation = expect(search).rejects.toThrow("DDGS search timed out.");

    await vi.advanceTimersByTimeAsync(30_000);

    await expectation;
    expect(harness.children[0]?.kill).toHaveBeenCalledTimes(1);
  });

  it("passes query and limit through stdin JSON without shell interpolation", async () => {
    const query = "quotes ' and $(touch nope)";
    const harness = createSpawnHarness({
      stdout: { results: [] }
    });
    const provider = configureDdgs({
      pythonStateRoot: "/state",
      status: installedStatus("verified"),
      spawnProcess: harness.spawnProcess
    });

    await provider.search?.(query, { maxResults: 99 });

    expect(harness.spawnProcess).toHaveBeenCalledWith("/managed/python", expect.any(Array), {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const [, args] = harness.spawnProcess.mock.calls[0]!;
    expect(args[0]).toBe("-c");
    expect(args[1]).toContain("from ddgs import DDGS");
    expect(args[1]).not.toContain(query);
    expect(harness.stdinPayloads).toEqual([JSON.stringify({
      query,
      limit: 20
    })]);
  });

  it("does not install packages at runtime", async () => {
    const statusChecker = vi.fn(async () => installedStatus("verified"));
    const harness = createSpawnHarness({
      stdout: { results: [] }
    });
    const provider = configureDdgs({
      pythonStateRoot: "/state",
      statusChecker,
      spawnProcess: harness.spawnProcess
    });

    await provider.search?.("estacoda");

    expect(statusChecker).toHaveBeenCalledWith({
      stateRoot: "/state",
      capabilityId: DDGS_CAPABILITY_ID
    });
    expect(harness.spawnProcess).toHaveBeenCalledTimes(1);
  });
});

function configureDdgs(options: {
  pythonStateRoot?: string;
  status?: ManagedPythonCapabilityInstallStatus;
  statusChecker?: WebResearchProviderContext["pythonCapabilityStatusChecker"];
  spawnProcess?: WebResearchSubprocessSpawn;
} = {}): WebResearchProvider {
  return ddgsProvider.configure?.({
    config: {},
    fetch: vi.fn(),
    credentialResolver: vi.fn(),
    pythonStateRoot: options.pythonStateRoot,
    pythonCapabilityStatusChecker: options.statusChecker ?? vi.fn(async () => options.status ?? installedStatus("verified")),
    pythonCapabilityPathResolver: vi.fn(() => ({
      envPath: "/managed/env",
      pythonPath: "/managed/python",
      pipCacheDir: "/managed/pip-cache",
      manifestPath: "/managed/env/env.json"
    })),
    subprocessSpawn: options.spawnProcess
  }) ?? ddgsProvider;
}

function installedStatus(status: "installed" | "verified"): ManagedPythonCapabilityInstallStatus {
  return {
    ok: true,
    status,
    capabilityId: DDGS_CAPABILITY_ID,
    version: "9.14.4",
    specHash: "hash",
    installedGroups: [],
    installedPackages: ["ddgs==9.14.4"],
    pythonPath: "/managed/python",
    envPath: "/managed/env",
    manifest: {
      id: DDGS_CAPABILITY_ID,
      version: "9.14.4",
      specHash: "hash",
      installedPackages: ["ddgs==9.14.4"],
      installedGroups: [],
      pythonPath: "/managed/python",
      envPath: "/managed/env",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      status
    } satisfies ManagedPythonCapabilityEnvManifest
  };
}

function createSpawnHarness(options: {
  stdout?: unknown;
  rawStdout?: string;
  stderr?: string;
  exitCode?: number;
  keepOpen?: boolean;
}) {
  const children: FakeChildProcess[] = [];
  const stdinPayloads: string[] = [];
  const spawnProcess = vi.fn<WebResearchSubprocessSpawn>(() => {
    const child = new FakeChildProcess();
    children.push(child);
    child.stdin.on("data", (chunk) => {
      stdinPayloads.push(String(chunk));
    });

    if (options.keepOpen !== true) {
      queueMicrotask(() => {
        if (options.stderr !== undefined) {
          child.stderr.write(options.stderr);
        }
        const rawStdout = options.rawStdout ?? JSON.stringify(options.stdout ?? { results: [] });
        child.stdout.write(rawStdout);
        child.emit("close", options.exitCode ?? 0, null);
      });
    }

    return child;
  });

  return {
    spawnProcess,
    children,
    stdinPayloads
  };
}
