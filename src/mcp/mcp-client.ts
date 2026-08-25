import { access, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolveOsHomeDir } from "../config/home-dir.js";
import { buildSafeChildEnv } from "../security/process-env.js";

export type MCPServerTransport = "stdio" | "http";

export type MCPFetchLike = (input: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

type JSONRPCRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
};

type JSONRPCResponse = {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
  method?: string;
  params?: unknown;
};

export type MCPToolDescriptor = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export type MCPResourceDescriptor = {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
};

export type MCPPromptDescriptor = {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
};

export type MCPServerCapabilities = {
  tools?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  prompts?: { listChanged?: boolean };
};

const MCP_LATEST_PROTOCOL_VERSION = "2025-11-25";

export class MCPClient {
  readonly #name: string;
  readonly #transport: MCPServerTransport;
  readonly #command: string | undefined;
  readonly #args: string[];
  readonly #cwd: string | undefined;
  readonly #env: Record<string, string> | undefined;
  readonly #url: string | undefined;
  readonly #headers: Record<string, string>;
  readonly #timeoutMs: number;
  readonly #connectTimeoutMs: number;
  readonly #fetch: MCPFetchLike;
  #child: ChildProcessWithoutNullStreams | undefined;
  #buffer = "";
  #nextId = 1;
  #started = false;
  #stderr = "";
  #stdioClosedError: Error | undefined;
  readonly #pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }>();

  capabilities: MCPServerCapabilities = {};

  constructor(options: {
    name: string;
    transport?: MCPServerTransport;
    command?: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
    connectTimeoutMs?: number;
    fetch?: MCPFetchLike;
  }) {
    this.#name = options.name;
    this.#transport = options.transport ?? "stdio";
    this.#command = options.command;
    this.#args = options.args ?? [];
    this.#cwd = options.cwd;
    this.#env = options.env;
    this.#url = options.url;
    this.#headers = options.headers ?? {};
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? defaultMcpConnectTimeoutMs(
      this.#transport,
      this.#timeoutMs,
      this.#command,
      this.#args
    );
    this.#fetch = options.fetch ?? defaultFetch;
  }

  async start(): Promise<void> {
    if (this.#started) {
      return;
    }

    if (this.#transport === "stdio") {
      if (typeof this.#command !== "string" || this.#command.trim().length === 0) {
        throw new Error(`MCP stdio server ${this.#name} requires a command`);
      }
      await this.#startStdio();
    } else {
      if (typeof this.#url !== "string" || this.#url.trim().length === 0) {
        throw new Error(`MCP HTTP server ${this.#name} requires a url`);
      }
    }

    const initialize = await this.#request("initialize", {
      protocolVersion: MCP_LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "EstaCoda",
        version: "0.0.0"
      }
    }, this.#connectTimeoutMs) as {
      capabilities?: MCPServerCapabilities;
    };
    this.capabilities = initialize.capabilities ?? {};
    await this.#notify("notifications/initialized", {});
    this.#started = true;
  }

  async listTools(): Promise<MCPToolDescriptor[]> {
    const result = await this.#request("tools/list", {}) as { tools?: MCPToolDescriptor[] };
    return result.tools ?? [];
  }

  async callTool(name: string, arguments_: Record<string, unknown>): Promise<unknown> {
    return await this.#request("tools/call", {
      name,
      arguments: arguments_
    });
  }

  async listResources(): Promise<MCPResourceDescriptor[]> {
    const result = await this.#request("resources/list", {}) as { resources?: MCPResourceDescriptor[] };
    return result.resources ?? [];
  }

  async readResource(uri: string): Promise<unknown> {
    return await this.#request("resources/read", { uri });
  }

  async listPrompts(): Promise<MCPPromptDescriptor[]> {
    const result = await this.#request("prompts/list", {}) as { prompts?: MCPPromptDescriptor[] };
    return result.prompts ?? [];
  }

  async getPrompt(name: string, args: Record<string, unknown>): Promise<unknown> {
    return await this.#request("prompts/get", {
      name,
      arguments: args
    });
  }

  async stop(): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    this.#started = false;
    this.#markStdioClosed(new Error(`MCP server ${this.#name} stopped`));
    if (child === undefined || child.killed) {
      return;
    }
    child.kill();
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      setTimeout(() => resolve(), 500);
    });
  }

  get transport(): MCPServerTransport {
    return this.#transport;
  }

  async #startStdio(): Promise<void> {
    const resolved = await resolveStdioCommand(this.#command!, this.#args);
    this.#stdioClosedError = undefined;
    this.#child = spawn(resolved.command, resolved.args, {
      cwd: this.#cwd,
      env: buildStdioEnv(this.#env),
      stdio: "pipe"
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => {
      this.#buffer += chunk;
      this.#pump();
    });
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderr += chunk;
    });
    this.#child.on("error", (error) => {
      this.#markStdioClosed(new Error(`MCP server ${this.#name} process error: ${error.message}`));
    });
    this.#child.on("exit", (code, signal) => {
      this.#markStdioClosed(new Error(`MCP server ${this.#name} exited (${code ?? "null"}${signal === null ? "" : `, ${signal}`})`));
    });
    this.#child.on("close", (code, signal) => {
      this.#markStdioClosed(new Error(`MCP server ${this.#name} closed (${code ?? "null"}${signal === null ? "" : `, ${signal}`})`));
    });
    this.#child.stdin.on("error", (error) => {
      this.#markStdioClosed(this.#stdioWriteError(error));
    });
  }

  async #notify(method: string, params?: unknown): Promise<void> {
    if (this.#transport === "http") {
      await this.#sendHttp({
        jsonrpc: "2.0",
        method,
        params
      });
      return;
    }

    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method,
      params
    });
    await this.#writeStdioLine(`${payload}\n`);
  }

  async #request(method: string, params?: unknown, timeoutMs = this.#timeoutMs): Promise<unknown> {
    const id = this.#nextId++;
    const payload: JSONRPCRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    if (this.#transport === "http") {
      const response = await this.#sendHttp(payload, timeoutMs);
      return this.#unwrapResponse(response, method);
    }

    const response = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`MCP request timed out: ${this.#name} ${method}`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });
      void this.#writeStdioLine(`${JSON.stringify(payload)}\n`).catch((error) => {
        if (this.#pending.delete(id)) {
          clearTimeout(timeout);
          reject(error);
        }
      });
    });

    return response;
  }

  async #writeStdioLine(line: string): Promise<void> {
    const child = this.#child;
    if (child === undefined) {
      throw this.#stdioClosedError ?? new Error(`MCP server ${this.#name} is not running`);
    }
    if (this.#stdioClosedError !== undefined) {
      throw this.#stdioClosedError;
    }
    if (
      child.exitCode !== null
      || child.signalCode !== null
      || child.stdin.destroyed
      || child.stdin.writableEnded
      || child.stdin.closed
      || !child.stdin.writable
    ) {
      const error = this.#stdioConnectionClosedError();
      this.#markStdioClosed(error);
      throw error;
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error | null) => {
        if (settled) {
          return;
        }
        settled = true;
        child.stdin.off("error", finish);
        if (error === undefined || error === null) {
          resolve();
          return;
        }
        const writeError = this.#stdioWriteError(error);
        this.#markStdioClosed(writeError);
        reject(writeError);
      };

      child.stdin.once("error", finish);
      try {
        child.stdin.write(line, "utf8", finish);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #stdioConnectionClosedError(): Error {
    return new Error(`MCP server ${this.#name} connection is closed`);
  }

  #stdioWriteError(error: Error): Error {
    const errorWithCode = error as Error & { code?: unknown };
    const code = typeof errorWithCode.code === "string"
      ? ` ${errorWithCode.code}`
      : "";
    return new Error(`MCP server ${this.#name} stdin write failed${code}: ${error.message}`);
  }

  #markStdioClosed(error: Error): void {
    if (this.#stdioClosedError === undefined) {
      this.#stdioClosedError = error;
    }
    this.#started = false;
    const closeError = this.#stdioClosedError;
    for (const pending of this.#pending.values()) {
      pending.reject(closeError);
    }
    this.#pending.clear();
  }

  async #sendHttp(payload: Record<string, unknown>, timeoutMs = this.#timeoutMs): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.#fetch(this.#url!, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...this.#headers
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`MCP HTTP request failed: ${this.#name} ${response.status} ${response.statusText}${body.length === 0 ? "" : ` - ${body}`}`);
      }
      if ("id" in payload === false) {
        return {};
      }
      return await response.json();
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`MCP request timed out: ${this.#name}`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  #unwrapResponse(response: unknown, method: string): unknown {
    if (typeof response !== "object" || response === null) {
      throw new Error(`Invalid MCP HTTP response for ${this.#name} ${method}`);
    }
    const message = response as JSONRPCResponse;
    if (message.error !== undefined) {
      throw new Error(`MCP ${this.#name} ${method} failed (${message.error.code}): ${message.error.message}`);
    }
    return message.result;
  }

  #pump(): void {
    while (true) {
      const trimmedStart = this.#buffer.trimStart();
      if (trimmedStart.startsWith("{")) {
        const newline = this.#buffer.indexOf("\n");
        if (newline === -1) {
          return;
        }
        const line = this.#buffer.slice(0, newline).trim();
        this.#buffer = this.#buffer.slice(newline + 1);
        if (line.length === 0) {
          continue;
        }
        try {
          this.#handleMessage(JSON.parse(line) as JSONRPCResponse);
        } catch {
          continue;
        }
        continue;
      }

      if (!trimmedStart.startsWith("Content-Length:")) {
        const newline = this.#buffer.indexOf("\n");
        if (newline === -1) {
          return;
        }
        this.#buffer = this.#buffer.slice(newline + 1);
        continue;
      }

      if (this.#buffer !== trimmedStart) {
        this.#buffer = trimmedStart;
      }
      const boundary = this.#buffer.indexOf("\r\n\r\n");
      if (boundary === -1) {
        return;
      }
      const header = this.#buffer.slice(0, boundary);
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/iu);
      if (lengthMatch === null) {
        this.#buffer = "";
        throw new Error(`Invalid MCP frame from ${this.#name}`);
      }
      const length = Number(lengthMatch[1]);
      const start = boundary + 4;
      if (this.#buffer.length < start + length) {
        return;
      }
      const body = this.#buffer.slice(start, start + length);
      this.#buffer = this.#buffer.slice(start + length);
      this.#handleMessage(JSON.parse(body) as JSONRPCResponse);
    }
  }

  #handleMessage(message: JSONRPCResponse): void {
    if (typeof message.id !== "number") {
      return;
    }
    const pending = this.#pending.get(message.id);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(message.id);
    if (message.error !== undefined) {
      pending.reject(new Error(`MCP ${this.#name} failed (${message.error.code}): ${message.error.message}`));
      return;
    }
    pending.resolve(message.result);
  }
}

function defaultMcpConnectTimeoutMs(
  transport: "stdio" | "http",
  requestTimeoutMs: number,
  command?: string,
  args: readonly string[] = []
): number {
  // Package-runner-backed stdio connectors commonly need more than one normal
  // request window for cold process startup and module loading. Operators can
  // still override this explicitly per connector.
  const executable = command?.split(/[\\/]/u).at(-1)?.toLocaleLowerCase("en-US");
  const packageRunner = executable === "npx" || executable === "npx.cmd" ||
    executable === "pnpx" || executable === "bunx" || executable === "uvx" ||
    (executable === "pnpm" && args[0] === "dlx");
  return transport === "stdio" && packageRunner
    ? Math.max(requestTimeoutMs, 30_000)
    : requestTimeoutMs;
}

export const __defaultMcpConnectTimeoutMsForTest = defaultMcpConnectTimeoutMs;

function buildStdioEnv(customEnv: Record<string, string> | undefined): Record<string, string> {
  return buildSafeChildEnv({
    extra: customEnv
  });
}

const defaultFetch: MCPFetchLike = async (input, init) => {
  const response = await fetch(input, init);
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    json: async () => await response.json(),
    text: async () => await response.text()
  };
};

async function resolveStdioCommand(command: string, args: string[]): Promise<{
  command: string;
  args: string[];
}> {
  if (basename(command) !== "npx") {
    return { command, args };
  }

  const spec = parseNpxPackageSpec(args);
  if (spec === undefined) {
    return { command, args };
  }

  const binary = await resolveNpxCachedBinary(spec.packageName);
  if (binary === undefined) {
    return { command, args };
  }

  return {
    command: binary,
    args: spec.serverArgs
  };
}

function parseNpxPackageSpec(args: string[]): {
  packageName: string;
  serverArgs: string[];
} | undefined {
  let index = 0;
  while (index < args.length) {
    const value = args[index];
    if (value === "--") {
      index += 1;
      break;
    }
    if (value === "-y" || value === "--yes" || value === "--quiet" || value === "-q") {
      index += 1;
      continue;
    }
    if (value.startsWith("-")) {
      index += 1;
      continue;
    }
    return {
      packageName: value,
      serverArgs: args.slice(index + 1)
    };
  }

  return undefined;
}

async function resolveNpxCachedBinary(packageName: string): Promise<string | undefined> {
  const npmCacheRoot = join(resolveUserHome(), ".npm", "_npx");
  let cacheDirs: string[];
  try {
    cacheDirs = await readdir(npmCacheRoot);
  } catch {
    return undefined;
  }

  for (const cacheDir of cacheDirs) {
    const packageRoot = join(npmCacheRoot, cacheDir, "node_modules", packageName);
    const packageJsonPath = join(packageRoot, "package.json");
    try {
      const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
        bin?: string | Record<string, string>;
        name?: string;
      };
      const binaryName = pickPackageBinaryName(packageJson, packageName);
      if (binaryName === undefined) {
        continue;
      }
      const candidate = join(npmCacheRoot, cacheDir, "node_modules", ".bin", binaryName);
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  return undefined;
}

function pickPackageBinaryName(packageJson: {
  bin?: string | Record<string, string>;
  name?: string;
}, packageName: string): string | undefined {
  if (typeof packageJson.bin === "string") {
    const fallback = packageJson.name ?? packageName;
    return fallback.startsWith("@")
      ? fallback.slice(fallback.indexOf("/") + 1)
      : fallback;
  }

  if (typeof packageJson.bin === "object" && packageJson.bin !== null) {
    const entries = Object.keys(packageJson.bin);
    if (entries.length === 0) {
      return undefined;
    }
    const unscoped = packageName.startsWith("@")
      ? packageName.slice(packageName.indexOf("/") + 1)
      : packageName;
    return entries.find((entry) => entry === unscoped) ?? entries[0];
  }

  return undefined;
}

function resolveUserHome(): string {
  return resolveOsHomeDir();
}

export const __resolveNpxCachedBinaryForTest = resolveNpxCachedBinary;
