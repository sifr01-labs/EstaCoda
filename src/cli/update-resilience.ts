import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { InstallMethodInfo } from "../lifecycle/install-method.js";
import type { UpdateApplyResult } from "../lifecycle/update-engine.js";

type SignalProcessLike = {
  on(signal: "SIGHUP", listener: () => void): unknown;
  off?(signal: "SIGHUP", listener: () => void): unknown;
  removeListener?(signal: "SIGHUP", listener: () => void): unknown;
};

type WritableLike = {
  write: (...args: any[]) => boolean;
};

export type UpdateResilienceOptions = {
  homeDir: string;
  installMethod: InstallMethodInfo;
  run: () => Promise<UpdateApplyResult>;
  processLike?: SignalProcessLike;
  stdout?: WritableLike;
  stderr?: WritableLike;
  appendLog?: (path: string, text: string) => Promise<void>;
  now?: () => Date;
};

export type UpdateResilienceResult = {
  result: UpdateApplyResult;
  logPath?: string;
  logAvailable: boolean;
  logFailure?: string;
  sighupReceived: boolean;
};

export async function runManagedSourceUpdateWithResilience(options: UpdateResilienceOptions): Promise<UpdateResilienceResult> {
  const logPath = updateLogPath(options.homeDir);
  const appendLog = options.appendLog ?? defaultAppendLog;
  const now = options.now ?? (() => new Date());
  let logAvailable = false;
  let logFailure: string | undefined;
  let sighupReceived = false;
  const pendingLogWrites: Array<Promise<void>> = [];

  const log = async (message: string): Promise<void> => {
    const line = `[${now().toISOString()}] ${redactUpdateLogText(message)}\n`;
    try {
      await appendLog(logPath, line);
      logAvailable = true;
    } catch (error) {
      logFailure ??= error instanceof Error ? error.message : String(error);
      // Logging must never make a safe managed-source update less safe.
    }
  };
  const queueLog = (message: string): void => {
    pendingLogWrites.push(log(message));
  };

  const restoreStdout = installBrokenPipeGuard(options.stdout, {
    onWrite: (chunk) => queueLog(`stdout: ${chunk}`),
    onBrokenPipe: (error) => queueLog(`stdout closed during update: ${formatBrokenPipeError(error)}`)
  });
  const restoreStderr = installBrokenPipeGuard(options.stderr, {
    onWrite: (chunk) => queueLog(`stderr: ${chunk}`),
    onBrokenPipe: (error) => queueLog(`stderr closed during update: ${formatBrokenPipeError(error)}`)
  });
  const restoreSighup = installSighupHandler(options.processLike, () => {
    sighupReceived = true;
    queueLog("SIGHUP received during managed-source update; continuing where possible.");
  });

  await log(`=== update start: ${options.installMethod.method} ===`);
  await log(`installDir: ${options.installMethod.installDir ?? "(unknown)"}`);
  await log(`branch: ${options.installMethod.expectedBranch ?? options.installMethod.branch ?? "(unknown)"}`);

  let result: UpdateApplyResult;
  try {
    result = await options.run();
    await log(result.kind === "success" ? "update result: success" : "update result: error");
    await log(result.message);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await log(`update threw: ${message}`);
    result = { kind: "error", message: `Update failed: ${message}` };
  } finally {
    await Promise.allSettled(pendingLogWrites);
    await log(`=== update end: ${options.installMethod.method} ===`);
    restoreSighup();
    restoreStdout();
    restoreStderr();
  }

  return {
    result,
    logPath: logAvailable ? logPath : undefined,
    logAvailable,
    logFailure: logFailure === undefined ? undefined : redactUpdateLogText(logFailure),
    sighupReceived
  };
}

export function updateLogPath(homeDir: string): string {
  return join(homeDir, ".estacoda", "logs", "update.log");
}

export function redactUpdateLogText(value: string): string {
  return value
    .replace(/(https?:\/\/)([^/@\s]+@)/gi, "$1[redacted]@")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/\b(Authorization:\s*(?:Bearer\s+)?)[^\s]+/gi, "$1[redacted]")
    .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)[A-Z0-9_]*=)[^\s]+/g, "$1[redacted]")
    .replace(/\b((?:api[_-]?key|apikey|token|key|secret|password)\s*[:=]\s*)[^\s]+/gi, "$1[redacted]");
}

async function defaultAppendLog(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, text, "utf8");
}

function installSighupHandler(processLike: SignalProcessLike | undefined, onSighup: () => void): () => void {
  if (processLike === undefined) {
    return () => {};
  }

  processLike.on("SIGHUP", onSighup);
  return () => {
    if (processLike.off !== undefined) {
      processLike.off("SIGHUP", onSighup);
      return;
    }
    processLike.removeListener?.("SIGHUP", onSighup);
  };
}

function installBrokenPipeGuard(stream: WritableLike | undefined, handlers: {
  onWrite: (chunk: string) => void;
  onBrokenPipe: (error: unknown) => void;
}): () => void {
  if (stream === undefined) {
    return () => {};
  }

  const originalWrite = stream.write;
  stream.write = (...args: unknown[]) => {
    try {
      const last = args[args.length - 1];
      if (typeof last === "function") {
        args[args.length - 1] = (error?: unknown) => {
          if (isBrokenPipeError(error)) {
            handlers.onBrokenPipe(error);
            return;
          }
          (last as (error?: unknown) => void)(error);
        };
      }

      const chunk = typeof args[0] === "string" || Buffer.isBuffer(args[0]) ? String(args[0]) : "";
      if (chunk.length > 0) {
        handlers.onWrite(chunk);
      }

      return originalWrite.apply(stream, args);
    } catch (error) {
      if (isBrokenPipeError(error)) {
        handlers.onBrokenPipe(error);
        return false;
      }
      throw error;
    }
  };

  return () => {
    stream.write = originalWrite;
  };
}

function isBrokenPipeError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error.code === "EPIPE" || error.code === "EBADF");
}

function formatBrokenPipeError(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    return String(error.code);
  }
  return "closed stream";
}
