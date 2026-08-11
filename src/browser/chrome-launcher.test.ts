import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { launchChrome } from "./chrome-launcher.js";

class FakeChildProcess extends EventEmitter {
  pid = 12_345;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  kill = vi.fn((signal?: NodeJS.Signals | number) => {
    this.killed = true;
    this.signalCode = typeof signal === "string" ? signal : "SIGTERM";
    return true;
  });
}

type SpawnMock = ReturnType<typeof vi.fn<(command: string, args: string[], options?: unknown) => FakeChildProcess>>;

function missingFileError(): NodeJS.ErrnoException {
  const error = new Error("missing") as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

function createHarness(overrides: {
  readFile?: (path: string) => Promise<string>;
  fetch?: typeof globalThis.fetch;
  child?: FakeChildProcess;
  mkdtemp?: (prefix: string) => Promise<string>;
  userDataDir?: string;
  readAppArmorUsernsRestriction?: () => Promise<string | undefined>;
} = {}) {
  const child = overrides.child ?? new FakeChildProcess();
  const spawn: SpawnMock = vi.fn(() => child);
  const readFile = vi.fn(async (path: string) => {
    if (overrides.readFile !== undefined) {
      return overrides.readFile(path);
    }
    if (path.endsWith("DevToolsActivePort")) {
      return "9333\n/devtools/browser/session\n";
    }
    throw missingFileError();
  });
  const fetch = overrides.fetch ?? vi.fn(async () => ({
    ok: true,
    status: 200
  } as Response));
  const rm = vi.fn(async () => undefined);
  const mkdir = vi.fn(async () => undefined);
  const mkdtemp = vi.fn(overrides.mkdtemp ?? (async () => "/tmp/estacoda-chrome-test"));

  return {
    child,
    spawn,
    readFile,
    fetch,
    rm,
    mkdir,
    mkdtemp,
    options: {
      launchExecutable: "/usr/bin/chromium",
      userDataDir: overrides.userDataDir,
      spawn: spawn as never,
      readFile: readFile as never,
      fetch,
      rm: rm as never,
      mkdir: mkdir as never,
      mkdtemp: mkdtemp as never,
      tmpdir: () => "/tmp",
      getuid: () => 1000,
      readAppArmorUsernsRestriction: overrides.readAppArmorUsernsRestriction ?? (async () => undefined),
      timeoutMs: 50
    }
  };
}

function spawnedArgs(spawn: SpawnMock): string[] {
  return spawn.mock.calls[0]?.[1] ?? [];
}

describe("launchChrome", () => {
  it("spawns the executable with an args array and no shell", async () => {
    const harness = createHarness();

    await launchChrome(harness.options);

    expect(harness.spawn).toHaveBeenCalledWith(
      "/usr/bin/chromium",
      expect.any(Array),
      expect.objectContaining({ shell: false })
    );
    expect(typeof spawnedArgs(harness.spawn)).not.toBe("string");
  });

  it("includes default Chrome flags and remote debugging port zero", async () => {
    const harness = createHarness();

    await launchChrome(harness.options);
    const args = spawnedArgs(harness.spawn);

    expect(args).toEqual(expect.arrayContaining([
      "--remote-debugging-port=0",
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows"
    ]));
  });

  it("launches a visible browser when headless is false", async () => {
    const harness = createHarness();

    await launchChrome({
      ...harness.options,
      headless: false
    });

    expect(spawnedArgs(harness.spawn)).not.toContain("--headless=new");
  });

  it("lets visible mode override legacy headless launch arguments", async () => {
    const harness = createHarness();

    await launchChrome({
      ...harness.options,
      headless: false,
      launchArgs: ["--headless=new", "--app=https://example.test"],
      chromeFlags: ["--headless", "--disable-gpu"]
    });

    expect(spawnedArgs(harness.spawn)).not.toContain("--headless=new");
    expect(spawnedArgs(harness.spawn)).not.toContain("--headless");
    expect(spawnedArgs(harness.spawn)).toEqual(expect.arrayContaining([
      "--app=https://example.test",
      "--disable-gpu"
    ]));
  });

  it("uses an isolated temporary user data dir when none is supplied", async () => {
    const harness = createHarness();

    const launched = await launchChrome(harness.options);
    const args = spawnedArgs(harness.spawn);

    expect(harness.mkdtemp).toHaveBeenCalledWith("/tmp/estacoda-chrome-");
    expect(args).toContain("--user-data-dir=/tmp/estacoda-chrome-test");
    expect(launched.userDataDir).toBe("/tmp/estacoda-chrome-test");
  });

  it("uses a supplied userDataDir and does not delete it on cleanup", async () => {
    const harness = createHarness({ userDataDir: "/profile/chrome" });

    const launched = await launchChrome(harness.options);
    const args = spawnedArgs(harness.spawn);
    await launched.kill();

    expect(harness.mkdtemp).not.toHaveBeenCalled();
    expect(harness.mkdir).toHaveBeenCalledWith("/profile/chrome", { recursive: true });
    expect(args).toContain("--user-data-dir=/profile/chrome");
    expect(harness.rm).not.toHaveBeenCalled();
  });

  it("discovers the DevToolsActivePort port and returns the endpoint", async () => {
    const harness = createHarness({
      readFile: async () => "4567\n/devtools/browser/session\n"
    });

    const launched = await launchChrome(harness.options);

    expect(launched.port).toBe(4567);
    expect(launched.endpoint).toBe("http://127.0.0.1:4567");
    expect(harness.readFile).toHaveBeenCalledWith("/tmp/estacoda-chrome-test/DevToolsActivePort", "utf8");
  });

  it("health checks /json/version", async () => {
    const harness = createHarness();

    await launchChrome(harness.options);

    expect(harness.fetch).toHaveBeenCalledWith("http://127.0.0.1:9333/json/version", { method: "GET" });
  });

  it("injects --no-sandbox when running as root", async () => {
    const harness = createHarness();

    await launchChrome({
      ...harness.options,
      getuid: () => 0
    });

    expect(spawnedArgs(harness.spawn)).toContain("--no-sandbox");
  });

  it("injects --no-sandbox when AppArmor userns restriction is enabled", async () => {
    const harness = createHarness({ readAppArmorUsernsRestriction: async () => "1\n" });

    await launchChrome(harness.options);

    expect(spawnedArgs(harness.spawn)).toContain("--no-sandbox");
  });

  it("does not duplicate --no-sandbox when explicitly provided", async () => {
    const harness = createHarness();

    await launchChrome({
      ...harness.options,
      chromeFlags: ["--no-sandbox"],
      getuid: () => 0
    });
    const args = spawnedArgs(harness.spawn);

    expect(args.filter((arg) => arg === "--no-sandbox")).toHaveLength(1);
  });

  it("appends launchArgs and chromeFlags as individual args", async () => {
    const harness = createHarness();

    await launchChrome({
      ...harness.options,
      launchArgs: ["--app=https://example.test"],
      chromeFlags: ["--disable-gpu"]
    });
    const args = spawnedArgs(harness.spawn);

    expect(args.slice(0, 2)).toEqual(["--app=https://example.test", "--disable-gpu"]);
  });

  it("rejects empty and unsafe user args deterministically", async () => {
    const harness = createHarness();

    await expect(launchChrome({
      ...harness.options,
      launchArgs: ["  "]
    })).rejects.toThrow("launchArgs[0] must be a non-empty string");
    await expect(launchChrome({
      ...harness.options,
      chromeFlags: ["--flag=value;rm"]
    })).rejects.toThrow("chromeFlags[0] must not contain shell syntax or embedded whitespace");
    await expect(launchChrome({
      ...harness.options,
      chromeFlags: ["--flag value"]
    })).rejects.toThrow("chromeFlags[0] must not contain shell syntax or embedded whitespace");
  });

  it("rejects blocked isolation-undermining flags", async () => {
    const harness = createHarness();

    await expect(launchChrome({
      ...harness.options,
      chromeFlags: ["--remote-debugging-port=9222"]
    })).rejects.toThrow("chromeFlags[0] is not allowed because Chrome launcher manages --remote-debugging-port internally");
    await expect(launchChrome({
      ...harness.options,
      launchArgs: ["--user-data-dir=/tmp/profile"]
    })).rejects.toThrow("launchArgs[0] is not allowed because Chrome launcher manages --user-data-dir internally");
  });

  it("rejects proxy credentials in proxy-server flags", async () => {
    const harness = createHarness();

    await expect(launchChrome({
      ...harness.options,
      chromeFlags: ["--proxy-server=http://user:pass@example.test:8080"]
    })).rejects.toThrow("chromeFlags[0] must not include proxy credentials");
  });

  it("kills the process and deletes temporary user data on cleanup", async () => {
    const harness = createHarness();

    const launched = await launchChrome(harness.options);
    await launched.kill();

    expect(harness.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(harness.rm).toHaveBeenCalledWith("/tmp/estacoda-chrome-test", { recursive: true, force: true });
  });

  it("does not throw when cleanup sees an already-exited process", async () => {
    const child = new FakeChildProcess();
    const harness = createHarness({ child });
    const launched = await launchChrome(harness.options);
    child.exitCode = 0;

    await expect(launched.kill()).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
    expect(harness.rm).toHaveBeenCalledWith("/tmp/estacoda-chrome-test", { recursive: true, force: true });
  });

  it("kills the process and cleans a temporary dir on spawn error", async () => {
    const child = new FakeChildProcess();
    const harness = createHarness({
      child,
      readFile: async () => new Promise<string>(() => undefined)
    });

    const launch = launchChrome(harness.options);
    await vi.waitFor(() => {
      expect(harness.spawn).toHaveBeenCalled();
    });
    child.emit("error", new Error("spawn failed"));

    await expect(launch).rejects.toThrow("spawn failed");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(harness.rm).toHaveBeenCalledWith("/tmp/estacoda-chrome-test", { recursive: true, force: true });
  });

  it("throws a clear error and cleans up on health check failure", async () => {
    const harness = createHarness({
      fetch: vi.fn(async () => ({ ok: false, status: 503 } as Response))
    });

    await expect(launchChrome(harness.options)).rejects.toThrow(
      "Chrome DevTools endpoint health check failed for http://127.0.0.1:9333/json/version"
    );
    expect(harness.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(harness.rm).toHaveBeenCalledWith("/tmp/estacoda-chrome-test", { recursive: true, force: true });
  });

  it("throws a clear error when DevToolsActivePort never appears", async () => {
    const harness = createHarness({
      readFile: async () => {
        throw missingFileError();
      }
    });

    await expect(launchChrome({
      ...harness.options,
      timeoutMs: 1
    })).rejects.toThrow("Timed out waiting for Chrome DevToolsActivePort");
    expect(harness.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(harness.rm).toHaveBeenCalledWith("/tmp/estacoda-chrome-test", { recursive: true, force: true });
  });

  it("throws a clear error for invalid DevToolsActivePort values", async () => {
    const harness = createHarness({
      readFile: async () => "not-a-port\n"
    });

    await expect(launchChrome({
      ...harness.options,
      timeoutMs: 1
    })).rejects.toThrow("Chrome DevToolsActivePort contained an invalid port: not-a-port");
  });

  it("throws a clear error when Chrome exits before port discovery", async () => {
    const child = new FakeChildProcess();
    child.exitCode = 1;
    const harness = createHarness({
      child,
      readFile: async () => {
        throw missingFileError();
      }
    });

    await expect(launchChrome(harness.options)).rejects.toThrow("Chrome exited before DevToolsActivePort was available");
    expect(harness.rm).toHaveBeenCalledWith("/tmp/estacoda-chrome-test", { recursive: true, force: true });
  });
});
