import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { resolveHomeDir } from "../config/home-dir.js";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { resolveStateHome } from "../config/state-home.js";
import { defaultProfileId, readActiveProfile } from "../config/profile-home.js";
import { assessSecurityPolicy, type SecurityApprovalMode, type SecurityDecision, type SecurityPolicy, type SecurityRequest } from "../contracts/security.js";
import { ProviderExecutor } from "../providers/provider-executor.js";
import type { SessionDB } from "../contracts/session.js";
import type { SessionMessage } from "../contracts/session.js";
import type { Runtime, RuntimeOptions } from "../runtime/create-runtime.js";
import type { AgentLoopResponse } from "../runtime/agent-loop.js";
import { createRuntime } from "../runtime/create-runtime.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { resolveTokens } from "../theme/token-resolver.js";
import type { WorkspaceFsAdapter } from "../tools/workspace-tools.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { createSecurityPolicyForMode } from "../security/security-policy-factory.js";
import { acpRuntimeToolEventTitle, acpToolExecutionTitle } from "./tool-display.js";

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcSuccess = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
};

type JsonRpcError = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

type AcpServerOptions = {
  workspaceRoot: string;
  homeDir?: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  sessionDb?: SessionDB;
  runtimeFactory?: (options: {
    workspaceRoot: string;
    sessionId: string;
    homeDir: string;
    sessionDb: SessionDB;
    securityPolicy: SecurityPolicy;
  }) => Promise<Runtime>;
  permissionTimeoutMs?: number;
};

type SessionGrants = {
  allowOnce: Set<string>;
  allowAlways: Set<string>;
  rejectAlways: Set<string>;
};

type AcpSession = {
  acpSessionId: string;
  estacodaSessionId: string;
  workspaceRoot: string;
  runtime: Runtime;
  messages: SessionMessage[];
  grants: SessionGrants;
  activeTurn?: AbortController;
};

type RequestPermissionOutcome =
  | { outcome: "selected"; optionId: string; source?: "client" | "default-deny" }
  | { outcome: "cancelled" };

type PromptStopReason = "end_turn" | "cancelled" | "error";

const ACP_PROTOCOL_VERSION = 1;

export async function runAcpServer(options: AcpServerOptions): Promise<void> {
  const server = new AcpServer(options);
  await server.run();
}

export class AcpServer {
  readonly #workspaceRoot: string;
  readonly #homeDir: string;
  readonly #profileId: string;
  readonly #input: NodeJS.ReadableStream;
  readonly #output: NodeJS.WritableStream;
  readonly #sessionDb: SessionDB;
  readonly #closeSessionDb: boolean;
  readonly #runtimeFactory: AcpServerOptions["runtimeFactory"];
  readonly #permissionTimeoutMs: number;
  readonly #pendingOutgoing = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }>();
  readonly #pendingPermissionBySession = new Map<string, number>();
  #nextOutgoingId = 1_000;
  readonly #sessions = new Map<string, AcpSession>();
  #clientFsReadText = false;
  #buffer = "";
  #closed = false;

  constructor(options: AcpServerOptions) {
    this.#workspaceRoot = options.workspaceRoot;
    this.#homeDir = resolveHomeDir(options.homeDir);
    this.#profileId = readActiveProfile({ homeDir: this.#homeDir })?.profileId ?? defaultProfileId();
    this.#input = options.input ?? process.stdin;
    this.#output = options.output ?? process.stdout;
    this.#runtimeFactory = options.runtimeFactory;
    this.#permissionTimeoutMs = options.permissionTimeoutMs ?? 30_000;
    if (options.sessionDb !== undefined) {
      this.#sessionDb = options.sessionDb;
      this.#closeSessionDb = false;
    } else {
      const stateHome = resolveStateHome({ homeDir: this.#homeDir });
      prepareSessionDbFileSync(stateHome.sessionsSqlitePath);
      this.#sessionDb = new SQLiteSessionDB({
        path: stateHome.sessionsSqlitePath
      });
      this.#closeSessionDb = true;
    }
  }

  async run(): Promise<void> {
    await mkdir(resolveStateHome({ homeDir: this.#homeDir }).stateRoot, { recursive: true });
    this.#input.setEncoding?.("utf8");

    await new Promise<void>((resolve) => {
      const onData = (chunk: string | Buffer) => {
        this.#buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        void this.#pump();
      };
      const onEnd = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        this.#input.off("data", onData);
        this.#input.off("end", onEnd);
        this.#input.off("error", onError);
      };

      this.#input.on("data", onData);
      this.#input.once("end", onEnd);
      this.#input.once("error", onError);
    });

    await this.close();
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await Promise.all([...this.#sessions.values()].map(async (session) => {
      session.activeTurn?.abort("server closing");
      await session.runtime.dispose().catch(() => undefined);
    }));
    this.#sessions.clear();
    if (this.#closeSessionDb && this.#sessionDb instanceof SQLiteSessionDB) {
      this.#sessionDb.close();
    }
  }

  async #pump(): Promise<void> {
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = this.#buffer.slice(0, newline).replace(/\r$/u, "").trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length === 0) {
        continue;
      }

      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.#write({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32700,
            message: "Parse error"
          }
        });
        continue;
      }

      if (typeof message.method === "string") {
        await this.#handle(message as JsonRpcRequest);
        continue;
      }

      this.#handleOutgoingResponse(message);
    }
  }

  async #handle(request: JsonRpcRequest): Promise<void> {
    const id = request.id ?? null;

    try {
      switch (request.method) {
        case "initialize":
          {
            const parsed = asObject(request.params);
            const clientCapabilities = asObject(parsed.clientCapabilities);
            const fsCapabilities = asObject(clientCapabilities.fs);
            this.#clientFsReadText = fsCapabilities.readTextFile === true;
          }
          this.#write({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: ACP_PROTOCOL_VERSION,
              agentCapabilities: {
                loadSession: true,
                promptCapabilities: {
                  image: false,
                  audio: false,
                  embeddedContext: false
                },
                sessionCapabilities: {
                  newSession: true,
                  loadSession: true,
                  listSessions: true,
                  cancelPrompt: true,
                  cwd: true
                }
              },
              agentInfo: {
                name: "estacoda",
                version: "0.0.0"
              },
              authMethods: []
            }
          });
          return;
        case "authenticate":
          this.#write({
            jsonrpc: "2.0",
            id,
            result: {
              authenticated: true
            }
          });
          return;
        case "session/new":
          this.#write({
            jsonrpc: "2.0",
            id,
            result: await this.#newSession(request.params)
          });
          return;
        case "session/load":
          this.#write({
            jsonrpc: "2.0",
            id,
            result: await this.#loadSession(request.params)
          });
          return;
        case "session/list":
          this.#write({
            jsonrpc: "2.0",
            id,
            result: await this.#listSessions()
          });
          return;
        case "session/prompt":
          this.#write({
            jsonrpc: "2.0",
            id,
            result: await this.#promptSession(request.params)
          });
          return;
        case "session/cancel":
          await this.#cancelSession(request.params);
          return;
        default:
          this.#write({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `Method not found: ${request.method}`
            }
          });
      }
    } catch (error) {
      this.#write({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  async #newSession(params: unknown): Promise<{ sessionId: string }> {
    const parsed = asObject(params);
    const workspaceRoot = typeof parsed.cwd === "string" && parsed.cwd.length > 0
      ? parsed.cwd
      : this.#workspaceRoot;
    const acpSessionId = randomUUID();
    const estacodaSessionId = randomUUID();
    const grants = createSessionGrants();
    const runtime = await this.#buildRuntime({
      acpSessionId,
      workspaceRoot,
      sessionId: estacodaSessionId,
      grants
    });
    const session: AcpSession = {
      acpSessionId,
      estacodaSessionId: runtime.sessionId,
      workspaceRoot,
      runtime,
      messages: [],
      grants
    };
    this.#sessions.set(session.acpSessionId, session);
    this.#emitSessionInfo(session);
    return { sessionId: session.acpSessionId };
  }

  async #loadSession(params: unknown): Promise<{ sessionId: string }> {
    const parsed = asObject(params);
    const requested = expectString(parsed.sessionId, "sessionId");
    const existing = this.#sessions.get(requested);
    if (existing !== undefined) {
      await this.#replayMessages(existing);
      this.#emitSessionInfo(existing);
      return { sessionId: existing.acpSessionId };
    }

    const record = await this.#sessionDb.getSession(requested);
    if (record === undefined) {
      throw new Error(`Unknown session: ${requested}`);
    }

    const workspaceRoot = typeof record.metadata?.workspaceRoot === "string"
      ? record.metadata.workspaceRoot
      : this.#workspaceRoot;
    const grants = createSessionGrants();
    const runtime = await this.#buildRuntime({
      acpSessionId: requested,
      workspaceRoot,
      sessionId: record.id,
      grants
    });
    const messages = await this.#sessionDb.listMessages(record.id);
    const session: AcpSession = {
      acpSessionId: requested,
      estacodaSessionId: record.id,
      workspaceRoot,
      runtime,
      messages,
      grants
    };
    this.#sessions.set(session.acpSessionId, session);
    this.#emitSessionInfo(session);
    await this.#replayMessages(session);
    return { sessionId: session.acpSessionId };
  }

  async #listSessions(): Promise<{
    sessions: Array<{ sessionId: string; title?: string; updatedAt: string }>;
  }> {
    const sessions = await this.#sessionDb.listSessions();
    return {
      sessions: sessions.map((session) => ({
        sessionId: session.id,
        title: session.title,
        updatedAt: session.updatedAt
      }))
    };
  }

  async #promptSession(params: unknown): Promise<{ stopReason: PromptStopReason }> {
    const parsed = asObject(params);
    const acpSessionId = expectString(parsed.sessionId, "sessionId");
    const prompt = extractPromptText(parsed.prompt ?? parsed.input ?? parsed.content ?? parsed.messages);
    const session = this.#sessions.get(acpSessionId);
    if (session === undefined) {
      throw new Error(`Unknown session: ${acpSessionId}`);
    }
    const explicitShellCommand = extractExplicitShellCommand(prompt);

    session.activeTurn?.abort("replaced");
    const controller = new AbortController();
    session.activeTurn = controller;
    const runtimeText = await this.#buildRuntimeText(session, prompt);
    let streamedAgentText = false;

    try {
      let response = explicitShellCommand !== undefined
        ? await this.#executeExplicitShellFallback({
            session,
            acpSessionId,
            command: explicitShellCommand,
            signal: controller.signal
          })
        : await session.runtime.handle({
            text: runtimeText,
            channel: "web",
            workspaceRoot: session.workspaceRoot,
            signal: controller.signal,
            onEvent: async (event) => {
              switch (event.kind) {
                case "agent-start":
                  this.#notify({
                    jsonrpc: "2.0",
                    method: "session/update",
                    params: {
                      sessionId: acpSessionId,
                      update: {
                        sessionUpdate: "thought_message_chunk",
                        content: { type: "text", text: `thinking: ${event.input}` }
                      }
                    }
                  });
                  break;
                case "intent":
                  this.#notify({
                    jsonrpc: "2.0",
                    method: "session/update",
                    params: {
                      sessionId: acpSessionId,
                      update: {
                        sessionUpdate: "plan_update",
                        entries: event.labels.map((label) => ({
                          label,
                          state: "selected"
                        }))
                      }
                    }
                  });
                  break;
                case "skill":
                  this.#notify({
                    jsonrpc: "2.0",
                    method: "session/update",
                    params: {
                      sessionId: acpSessionId,
                      update: {
                        sessionUpdate: "thought_message_chunk",
                        content: { type: "text", text: `skill selected: ${event.name}` }
                      }
                    }
                  });
                  break;
                case "tool-start":
                  this.#notify({
                    jsonrpc: "2.0",
                    method: "session/update",
                    params: {
                      sessionId: acpSessionId,
                      update: {
                        sessionUpdate: "tool_call_update",
                        toolCallId: event.stepId ?? event.tool,
                        title: acpRuntimeToolEventTitle(event),
                        kind: classifyToolKind(event.tool),
                        status: "in_progress"
                      }
                    }
                  });
                  break;
                case "tool-result":
                  this.#notify({
                    jsonrpc: "2.0",
                    method: "session/update",
                    params: {
                      sessionId: acpSessionId,
                      update: {
                        sessionUpdate: "tool_call_update",
                        toolCallId: event.tool,
                        title: acpRuntimeToolEventTitle(event),
                        kind: classifyToolKind(event.tool),
                        status: event.ok === false ? "completed" : "completed",
                        content: summarizeToolResult(event)
                      }
                    }
                  });
                  break;
                case "provider-token":
                  streamedAgentText = true;
                  this.#notify({
                    jsonrpc: "2.0",
                    method: "session/update",
                    params: {
                      sessionId: acpSessionId,
                      update: {
                        sessionUpdate: "agent_message_chunk",
                        content: { type: "text", text: event.text }
                      }
                    }
                  });
                  break;
                case "provider-attempt":
                  this.#notify({
                    jsonrpc: "2.0",
                    method: "session/update",
                    params: {
                      sessionId: acpSessionId,
                      update: {
                        sessionUpdate: "session_info_update",
                        model: `${event.provider}/${event.model}`
                      }
                    }
                  });
                  break;
                case "agent-cancelled":
                  this.#notify({
                    jsonrpc: "2.0",
                    method: "session/update",
                    params: {
                      sessionId: acpSessionId,
                      update: {
                        sessionUpdate: "thought_message_chunk",
                        content: { type: "text", text: `cancelled: ${event.reason}` }
                      }
                    }
                  });
                  break;
                case "agent-final":
                  if (streamedAgentText === false) {
                    this.#notify({
                      jsonrpc: "2.0",
                      method: "session/update",
                      params: {
                        sessionId: acpSessionId,
                        update: {
                          sessionUpdate: "agent_message_chunk",
                          content: { type: "text", text: event.text }
                        }
                      }
                    });
                  }
                  break;
              }
            }
          });

      while (true) {
        const gated = response.toolExecutions.find((execution) => execution.decision === "ask");
        if (gated === undefined) {
          break;
        }

        const permissionOutcome = await this.#requestPermission(session, gated);
        if (permissionOutcome.outcome !== "selected") {
          const finalText = "Permission request was cancelled.";
          this.#notify({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: acpSessionId,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: gated.targetKey ?? gated.tool.name,
                title: acpToolExecutionTitle(gated),
                kind: classifyToolKind(gated.tool.name),
                status: "completed",
                content: [{ type: "content", content: { type: "text", text: finalText } }]
              }
            }
          });
          this.#notify({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: acpSessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: finalText }
              }
            }
          });
          return { stopReason: "end_turn" };
        }

        if (permissionOutcome.optionId.startsWith("reject")) {
          const finalText = permissionOutcome.source === "default-deny"
            ? "Permission request timed out or failed. Denied by default."
            : "Permission denied.";
          this.#notify({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: acpSessionId,
              update: {
                sessionUpdate: "thought_message_chunk",
                content: {
                  type: "text",
                  text: finalText
                }
              }
            }
          });
          this.#notify({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: acpSessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: finalText }
              }
            }
          });
          return { stopReason: "end_turn" };
        }

        applyPermissionSelection(session, gated.targetKey, permissionOutcome.optionId);
        this.#notify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: acpSessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: gated.targetKey ?? gated.tool.name,
              title: acpToolExecutionTitle(gated),
              kind: classifyToolKind(gated.tool.name),
              status: "in_progress",
              content: [{ type: "content", content: { type: "text", text: "Permission granted. Resuming action." } }]
            }
          }
        });
        response = explicitShellCommand !== undefined && gated.tool.name === "terminal.run"
          ? await this.#executeExplicitShellFallback({
              session,
              acpSessionId,
              command: explicitShellCommand,
              signal: controller.signal
            })
          : await session.runtime.handle({
              text: runtimeText,
              channel: "web",
              workspaceRoot: session.workspaceRoot,
              signal: controller.signal,
              onEvent: async (event) => {
                await this.#emitRuntimeEvent(acpSessionId, event);
              }
            });
      }

      session.messages = await this.#sessionDb.listMessages(session.estacodaSessionId);
      if ((explicitShellCommand !== undefined || response.providerExecution === undefined) && streamedAgentText === false && response.text.trim().length > 0) {
        this.#notify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: acpSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: response.text }
            }
          }
        });
      }
      const usage = response.providerExecution?.response?.usage;
      if (usage !== undefined) {
        this.#notify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: acpSessionId,
            update: {
              sessionUpdate: "usage_update",
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              totalTokens: usage.totalTokens
            }
          }
        });
      }

      return {
        stopReason: "end_turn"
      };
    } catch (error) {
      if (controller.signal.aborted) {
        return { stopReason: "cancelled" };
      }
      throw error;
    } finally {
      if (session.activeTurn === controller) {
        session.activeTurn = undefined;
      }
    }
  }

  async #cancelSession(params: unknown): Promise<void> {
    const parsed = asObject(params);
    const acpSessionId = expectString(parsed.sessionId, "sessionId");
    this.#sessions.get(acpSessionId)?.activeTurn?.abort("acp session cancelled");
    const pendingPermission = this.#pendingPermissionBySession.get(acpSessionId);
    if (pendingPermission !== undefined) {
      this.#pendingOutgoing.get(pendingPermission)?.resolve({ outcome: "cancelled" });
      this.#pendingOutgoing.delete(pendingPermission);
      this.#pendingPermissionBySession.delete(acpSessionId);
    }
  }

  async #buildRuntime(options: {
    acpSessionId: string;
    workspaceRoot: string;
    sessionId: string;
    grants: SessionGrants;
  }): Promise<Runtime> {
    if (this.#runtimeFactory !== undefined) {
      return await this.#runtimeFactory({
        workspaceRoot: options.workspaceRoot,
        sessionId: options.sessionId,
        homeDir: this.#homeDir,
        sessionDb: this.#sessionDb,
        securityPolicy: createAcpSecurityPolicy(options.grants, {
          allowEditorRead: this.#clientFsReadText
        })
      });
    }

    const config = await loadRuntimeConfig({
      workspaceRoot: options.workspaceRoot,
      homeDir: this.#homeDir,
      profileId: this.#profileId
    });

    const runtimeOptions: RuntimeOptions = {
      tokens: resolveTokens("standard", "dark", "kemetBlue"),
      model: config.model,
      primaryModelRoute: config.primaryModelRoute,
      modelFallbackRoutes: config.modelFallbackRoutes,
      profileId: this.#profileId,
      workspaceRoot: options.workspaceRoot,
      sessionId: options.sessionId,
      sessionDb: this.#sessionDb,
      closeSessionDbOnDispose: false,
      externalSkillRoots: config.skills.externalDirs,
      skillAutonomy: config.skills.autonomy,
      skillConfig: config.skills.config,
      ui: config.ui,
      agentProfile: config.profile,
      providerRegistry: config.providerRegistry,
      providerConfigs: config.config.providers,
      auxiliaryModels: config.auxiliaryModels,
      compression: config.compression,
      externalMemory: config.externalMemory,
      mcpServers: config.mcp.servers,
      browser: config.browser,
      imageGen: config.imageGen,
      tts: config.tts,
      stt: config.stt,
      telegramReady: config.channels.telegram.ready,
      enableWebNetwork: config.web.enableNetwork,
      webMaxContentChars: config.web.maxContentChars,
      webConfig: {
        backend: config.web.backend,
        searchBackend: config.web.searchBackend,
        extractBackend: config.web.extractBackend,
        crawlBackend: config.web.crawlBackend,
        brave: config.web.brave
      },
      securityConfig: {
        allowPrivateUrls: config.security.allowPrivateUrls,
        websiteBlocklist: config.security.websiteBlocklist
      },
      securityPolicy: createAcpSecurityPolicy(options.grants, {
        allowEditorRead: this.#clientFsReadText,
        mode: config.security.approvalMode,
        assessor: {
          ...config.security.assessor,
          providerExecutor: new ProviderExecutor({
            registry: config.providerRegistry,
            homeDir: config.homeDir,
            profileId: config.profileId
          }),
          sessionId: options.sessionId
        }
      }),
      workspaceFsAdapter: this.#clientFsReadText === true
        ? createAcpWorkspaceFsAdapter({
            readTextFile: async (input) => await this.#readEditorTextFile({
              sessionId: options.acpSessionId,
              ...input
            })
          })
        : undefined,
      homeDir: this.#homeDir
    };

    return await createRuntime(runtimeOptions);
  }

  async #buildRuntimeText(session: AcpSession, userText: string): Promise<string> {
    const editorFileContext = this.#clientFsReadText
      ? await this.#loadEditorFileContext(session.acpSessionId, session.workspaceRoot, userText)
      : [];

    return buildAcpRuntimePrompt({
      workspaceRoot: session.workspaceRoot,
      userText,
      editorFsReadAvailable: this.#clientFsReadText,
      editorFileContext
    });
  }

  async #executeExplicitShellFallback(input: {
    session: AcpSession;
    acpSessionId: string;
    command: string;
    signal?: AbortSignal;
  }): Promise<AgentLoopResponse> {
    const execution = await input.session.runtime.executeTool?.({
      tool: "terminal.run",
      toolInput: {
        command: input.command
      },
      signal: input.signal
    });

    if (execution === undefined) {
      return {
        label: "EstaCoda",
        text: "I couldn't execute the requested command because terminal.run is unavailable.",
        matchedSkills: [],
        intent: {
          nativeIntent: "general",
          labels: ["general"],
          confidence: 0.5,
          suggestedToolsets: [],
          suggestedSkills: [],
          confirmationRequired: false,
          evidence: [{
            kind: "native-intent",
            detail: "ACP explicit shell fallback.",
            weight: 0.5
          }],
          rationale: "ACP explicit shell fallback"
        },
        securityDecision: "deny",
        toolExecutions: [],
        toolPlans: [],
        skillOutcomes: [],
        artifacts: [],
        context: undefined,
        projectContext: undefined,
        providerExecution: undefined,
        progress: []
      };
    }

    await this.#notifyToolExecution(input.acpSessionId, execution);

    const text = formatExplicitShellExecutionMessage(execution);

    return {
      label: "EstaCoda",
      text,
      matchedSkills: [],
      intent: {
        nativeIntent: "general",
        labels: ["general"],
        confidence: 0.9,
        suggestedToolsets: ["shell-write"],
        suggestedSkills: [],
        confirmationRequired: execution.decision !== "allow",
        evidence: [{
          kind: "toolset-derived",
          detail: "ACP explicit shell fallback uses terminal.run.",
          weight: 0.9
        }],
        rationale: "ACP explicit shell fallback"
      },
      securityDecision: execution.decision,
      toolExecutions: [execution],
      toolPlans: [],
      skillOutcomes: [],
      artifacts: [],
      context: undefined,
      projectContext: undefined,
      providerExecution: undefined,
      progress: []
    };
  }

  async #notifyToolExecution(acpSessionId: string, execution: ToolExecutionRecord): Promise<void> {
    const contentText = formatToolExecutionSummary(execution);
    this.#notify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: acpSessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: execution.targetKey ?? execution.tool.name,
          title: acpToolExecutionTitle(execution),
          kind: classifyToolKind(execution.tool.name),
          status: execution.decision === "allow"
            ? execution.result?.ok === false
              ? "failed"
              : "completed"
            : "blocked",
          content: contentText.length === 0
            ? []
            : [{ type: "content", content: { type: "text", text: contentText } }]
        }
      }
    });

    if (execution.decision === "allow" && execution.result?.content !== undefined) {
      this.#notify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: acpSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: execution.result.content
            }
          }
        }
      });
    }
  }

  async #loadEditorFileContext(
    acpSessionId: string,
    workspaceRoot: string,
    userText: string
  ): Promise<Array<{
    path: string;
    content: string;
  }>> {
    const references = extractWorkspaceFileReferences(userText, workspaceRoot);
    const contexts: Array<{ path: string; content: string }> = [];

    for (const reference of references) {
      try {
        const content = await this.#readEditorTextFile({
          sessionId: acpSessionId,
          path: reference.absolutePath
        });
        contexts.push({
          path: reference.relativePath,
          content: content.length > 12_000 ? `${content.slice(0, 12_000)}\n...[truncated]` : content
        });
      } catch {
        continue;
      }
    }

    return contexts;
  }

  async #requestPermission(session: AcpSession, gated: {
    tool: { name: string };
    riskClass: string;
    targetKey?: string;
    targetSummary?: string;
  }): Promise<RequestPermissionOutcome> {
    const toolCallId = gated.targetKey ?? gated.tool.name;
    const title = acpToolExecutionTitle(gated);
    const toolCall = {
      sessionUpdate: "tool_call_update",
      toolCallId,
      title,
      kind: classifyPermissionToolKind(gated.tool.name, gated.riskClass),
      status: "pending",
      rawInput: {
        toolName: gated.tool.name,
        riskClass: gated.riskClass,
        targetKey: gated.targetKey,
        targetSummary: gated.targetSummary
      }
    };

    this.#notify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: session.acpSessionId,
        update: toolCall
      }
    });

    const rawOutcome = await this.#callClient<unknown>("session/request_permission", {
      sessionId: session.acpSessionId,
      toolCall,
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" }
      ]
    }, this.#permissionTimeoutMs, session.acpSessionId).catch(() => ({
      outcome: "selected",
      optionId: "reject-once",
      source: "default-deny"
    } satisfies RequestPermissionOutcome));

    return normalizePermissionOutcome(rawOutcome);
  }

  async #emitRuntimeEvent(acpSessionId: string, event: {
    kind: string;
    [key: string]: unknown;
  }): Promise<void> {
    switch (event.kind) {
      case "agent-start":
        this.#notify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: acpSessionId,
            update: {
              sessionUpdate: "thought_message_chunk",
              content: { type: "text", text: `thinking: ${String(event.input ?? "")}` }
            }
          }
        });
        return;
      case "intent":
        this.#notify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: acpSessionId,
            update: {
              sessionUpdate: "plan",
              entries: Array.isArray(event.labels)
                ? event.labels.map((label) => ({ label, status: "in_progress", priority: "medium" }))
                : []
            }
          }
        });
        return;
      case "skill":
        this.#notify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: acpSessionId,
            update: {
              sessionUpdate: "thought_message_chunk",
              content: { type: "text", text: `skill selected: ${String(event.name ?? "")}` }
            }
          }
        });
        return;
      case "tool-start":
        this.#notify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: acpSessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: String(event.stepId ?? event.tool ?? "tool"),
              title: acpRuntimeToolEventTitle(event),
              kind: classifyToolKind(String(event.tool ?? "tool")),
              status: "in_progress"
            }
          }
        });
        return;
      case "tool-result":
        this.#notify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: acpSessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: String(event.tool ?? "tool"),
              title: acpRuntimeToolEventTitle(event),
              kind: classifyToolKind(String(event.tool ?? "tool")),
              status: event.decision === "ask" ? "blocked" : event.ok === false ? "failed" : "completed",
              rawOutput: {
                decision: event.decision,
                ok: event.ok,
                riskClass: event.riskClass
              },
              content: summarizeToolContent(event)
            }
          }
        });
        return;
      case "provider-token":
        this.#notify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: acpSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: String(event.text ?? "") }
            }
          }
        });
        return;
      case "provider-attempt":
        this.#notify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: acpSessionId,
            update: {
              sessionUpdate: "session_info_update",
              model: `${String(event.provider ?? "")}/${String(event.model ?? "")}`
            }
          }
        });
        return;
      case "agent-cancelled":
        this.#notify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: acpSessionId,
            update: {
              sessionUpdate: "thought_message_chunk",
              content: { type: "text", text: `cancelled: ${String(event.reason ?? "")}` }
            }
          }
        });
        return;
      case "agent-final":
        this.#notify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: acpSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: String(event.text ?? "") }
            }
          }
        });
        return;
    }
  }

  async #readEditorTextFile(input: {
    sessionId: string;
    path: string;
    lineStart?: number;
    lineEnd?: number;
  }): Promise<string> {
    const params: Record<string, unknown> = {
      sessionId: input.sessionId,
      path: input.path
    };
    if (typeof input.lineStart === "number") {
      params.line = Math.max(1, input.lineStart);
    }
    if (typeof input.lineStart === "number" && typeof input.lineEnd === "number" && input.lineEnd >= input.lineStart) {
      params.limit = Math.max(1, input.lineEnd - input.lineStart + 1);
    }

    const result = await this.#callClient<unknown>("fs/read_text_file", params, 10_000);
    if (typeof result === "string") {
      return result;
    }
    const record = asObject(result);
    if (typeof record.content === "string") {
      return record.content;
    }
    if (Array.isArray(record.lines)) {
      return record.lines
        .map((line) => typeof line === "string" ? line : "")
        .join("\n");
    }
    throw new Error(`ACP client returned an unsupported fs/read_text_file payload for ${input.path}`);
  }

  async #callClient<T>(method: string, params: unknown, timeoutMs: number, sessionId?: string): Promise<T> {
    const id = this.#nextOutgoingId++;
    const response = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pendingOutgoing.delete(id);
        if (sessionId !== undefined) {
          this.#pendingPermissionBySession.delete(sessionId);
        }
        reject(new Error(`ACP client request timed out: ${method}`));
      }, timeoutMs);

      this.#pendingOutgoing.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          if (sessionId !== undefined) {
            this.#pendingPermissionBySession.delete(sessionId);
          }
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          if (sessionId !== undefined) {
            this.#pendingPermissionBySession.delete(sessionId);
          }
          reject(error);
        }
      });

      if (sessionId !== undefined) {
        this.#pendingPermissionBySession.set(sessionId, id);
      }

      this.#write({
        jsonrpc: "2.0",
        id,
        method,
        params
      } as unknown as JsonRpcSuccess);
    });

    return response as T;
  }

  #handleOutgoingResponse(message: Record<string, unknown>): void {
    const id = typeof message.id === "number" ? message.id : undefined;
    if (id === undefined) {
      return;
    }
    const pending = this.#pendingOutgoing.get(id);
    if (pending === undefined) {
      return;
    }
    this.#pendingOutgoing.delete(id);
    if (typeof message.error === "object" && message.error !== null) {
      pending.reject(new Error(String((message.error as { message?: unknown }).message ?? "ACP client error")));
      return;
    }
    pending.resolve((message as { result?: unknown }).result);
  }

  async #replayMessages(session: AcpSession): Promise<void> {
    for (const message of session.messages) {
      this.#notify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: session.acpSessionId,
          update: replayUpdateForMessage(message)
        }
      });
    }
  }

  #emitSessionInfo(session: AcpSession): void {
    this.#notify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: session.acpSessionId,
        update: {
          sessionUpdate: "session_info_update",
          sessionId: session.acpSessionId,
          cwd: session.workspaceRoot,
          estacodaSessionId: session.estacodaSessionId
        }
      }
    });
  }

  #notify(message: JsonRpcNotification): void {
    this.#write(message);
  }

  #write(message: JsonRpcSuccess | JsonRpcError | JsonRpcNotification): void {
    this.#output.write(`${JSON.stringify(message)}\n`, "utf8");
  }
}

function prepareSessionDbFileSync(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    writeFileSync(path, "", { mode: 0o600 });
  } else {
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best-effort permission tightening, matching session setup behavior.
    }
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function expectString(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw new Error(`Missing or invalid ${field}`);
}

function extractPromptText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(extractPromptText).filter((part) => part.length > 0).join("\n");
  }

  if (typeof value !== "object" || value === null) {
    return "";
  }

  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text;
  }
  if (typeof record.content === "string") {
    return record.content;
  }
  if (Array.isArray(record.content)) {
    return record.content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (typeof item === "object" && item !== null && typeof (item as { text?: unknown }).text === "string") {
          return String((item as { text: string }).text);
        }
        return "";
      })
      .filter((part) => part.length > 0)
      .join("\n");
  }
  if (Array.isArray(record.messages)) {
    return extractPromptText(record.messages);
  }

  return "";
}

function replayUpdateForMessage(message: SessionMessage): Record<string, unknown> {
  if (message.role === "user") {
    return {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: message.content }
    };
  }

  return {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: message.content }
  };
}

function classifyToolKind(toolName: string): string {
  if (toolName.startsWith("terminal.") || toolName.startsWith("process.")) {
    return "execute";
  }
  if (toolName.startsWith("file.read") || toolName.startsWith("workspace.") || toolName.startsWith("mcp.")) {
    return "read";
  }
  if (toolName.startsWith("file.write") || toolName.startsWith("file.patch")) {
    return "edit";
  }
  return "other";
}

function summarizeToolResult(event: {
  decision?: string;
  riskClass?: string;
  ok?: boolean;
  chars?: number;
  sentChars?: number;
  truncated?: boolean;
}): string {
  return [
    event.decision === undefined ? undefined : `decision=${event.decision}`,
    event.riskClass === undefined ? undefined : `risk=${event.riskClass}`,
    event.ok === undefined ? undefined : `ok=${event.ok ? "yes" : "no"}`,
    event.chars === undefined ? undefined : `chars=${event.chars}`,
    event.sentChars === undefined ? undefined : `sent=${event.sentChars}`,
    event.truncated === true ? "truncated=yes" : undefined
  ].filter((part): part is string => typeof part === "string").join(" ");
}

function summarizeToolContent(event: Record<string, unknown>): Array<Record<string, unknown>> {
  const summary = summarizeToolResult({
    decision: typeof event.decision === "string" ? event.decision : undefined,
    ok: typeof event.ok === "boolean" ? event.ok : undefined,
    riskClass: typeof event.riskClass === "string" ? event.riskClass : undefined,
    chars: typeof event.chars === "number" ? event.chars : undefined,
    sentChars: typeof event.sentChars === "number" ? event.sentChars : undefined
  });
  const target = typeof event.targetSummary === "string" ? event.targetSummary : undefined;
  const text = [summary, target].filter((part) => typeof part === "string" && part.length > 0).join(" · ");
  return text.length === 0
    ? []
    : [{ type: "content", content: { type: "text", text } }];
}

function formatToolExecutionSummary(execution: ToolExecutionRecord): string {
  if (execution.decision !== "allow") {
    return `Permission required for: ${acpToolExecutionTitle(execution)}`;
  }

  if (execution.result?.ok === false) {
    if (typeof execution.result.content === "string" && execution.result.content.length > 0) {
      return execution.result.content;
    }
    return `Command failed: ${acpToolExecutionTitle(execution)}`;
  }

  return execution.result?.content?.trim().length
    ? execution.result.content.trim()
    : "Command completed.";
}

function formatExplicitShellExecutionMessage(execution: ToolExecutionRecord): string {
  if (execution.decision !== "allow") {
    return "Permission required.";
  }

  if (execution.result?.ok === false) {
    const detail = typeof execution.result.content === "string" ? execution.result.content.trim() : "";
    if (detail === "command matches a destructive or privilege-escalating pattern") {
      return "The command was blocked by EstaCoda's safety policy because it matches a destructive pattern.";
    }
    return detail.length > 0
      ? `The command was blocked or failed: ${detail}`
      : "The command was blocked or failed.";
  }

  const detail = typeof execution.result?.content === "string" ? execution.result.content.trim() : "";
  return detail.length > 0
    ? `Command completed successfully.\n\n${detail}`
    : "Command completed successfully.";
}

function classifyPermissionToolKind(toolName: string, riskClass: string): string {
  if (toolName.startsWith("terminal.") || toolName.startsWith("process.")) return "execute";
  if (toolName.startsWith("file.read")) return "read";
  if (toolName.startsWith("file.write") || toolName.startsWith("file.patch")) return "edit";
  if (riskClass.includes("network")) return "fetch";
  return "other";
}

function createSessionGrants(): SessionGrants {
  return {
    allowOnce: new Set(),
    allowAlways: new Set(),
    rejectAlways: new Set()
  };
}

function normalizePermissionOutcome(value: unknown): RequestPermissionOutcome {
  if (isPermissionOutcome(value)) {
    return value;
  }

  if (typeof value === "object" && value !== null) {
    const nested = (value as { outcome?: unknown }).outcome;
    if (isPermissionOutcome(nested)) {
      return nested;
    }
  }

  return { outcome: "cancelled" };
}

function isPermissionOutcome(value: unknown): value is RequestPermissionOutcome {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as { outcome?: unknown; optionId?: unknown };
  if (candidate.outcome === "cancelled") {
    return true;
  }

  return candidate.outcome === "selected" && typeof candidate.optionId === "string";
}

function applyPermissionSelection(session: AcpSession, targetKey: string | undefined, optionId: string): void {
  if (targetKey === undefined) {
    return;
  }
  if (optionId === "allow-once") {
    session.grants.allowOnce.add(targetKey);
    return;
  }
  if (optionId === "allow-always") {
    session.grants.allowAlways.add(targetKey);
    return;
  }
  if (optionId === "reject-always") {
    session.grants.rejectAlways.add(targetKey);
  }
}

function createAcpSecurityPolicy(
  grants: SessionGrants,
  options: {
    allowEditorRead: boolean;
    mode?: SecurityApprovalMode;
    assessor?: import("../security/security-policy-factory.js").SecurityAssessorRuntimeConfig;
  }
): SecurityPolicy {
  const basePolicy = createSecurityPolicyForMode(options.mode ?? "adaptive", {
    assessor: options.assessor
  });
  const assess = async (request: SecurityRequest) => {
    const targetKey = request.targetKey;
    if (
      options.allowEditorRead === true &&
      request.toolName === "file.read" &&
      request.riskClass === "read-only-local"
    ) {
      return {
        decision: "allow" as const,
        mode: options.mode ?? "adaptive",
        reason: "Allowed by the ACP editor file bridge.",
        risk: "low" as const
      };
    }
    if (targetKey !== undefined) {
      if (grants.rejectAlways.has(targetKey)) {
        return {
          decision: "deny" as const,
          mode: options.mode ?? "adaptive",
          reason: "Denied by a persistent ACP rejection.",
          risk: "high" as const
        };
      }
      if (grants.allowAlways.has(targetKey)) {
        return {
          decision: "allow" as const,
          mode: options.mode ?? "adaptive",
          reason: "Allowed by a persistent ACP approval.",
          risk: "high" as const
        };
      }
      if (grants.allowOnce.delete(targetKey)) {
        return {
          decision: "allow" as const,
          mode: options.mode ?? "adaptive",
          reason: "Allowed once by an ACP approval grant.",
          risk: "high" as const
        };
      }
    }
    return await assessSecurityPolicy(basePolicy, request, options.mode ?? "adaptive");
  };
  return {
    assess(request: SecurityRequest) {
      return assess(request);
    },
    decide(request: SecurityRequest): SecurityDecision {
      const targetKey = request.targetKey;
      if (
        options.allowEditorRead === true &&
        request.toolName === "file.read" &&
        request.riskClass === "read-only-local"
      ) {
        return "allow";
      }
      if (targetKey !== undefined) {
        if (grants.rejectAlways.has(targetKey)) {
          return "deny";
        }
        if (grants.allowAlways.has(targetKey) || grants.allowOnce.has(targetKey)) {
          return "allow";
        }
      }
      return basePolicy.decide(request);
    }
  };
}

function createAcpWorkspaceFsAdapter(input: {
  readTextFile: WorkspaceFsAdapter["readTextFile"];
}): WorkspaceFsAdapter {
  return {
    readTextFile: input.readTextFile
  };
}

function buildAcpRuntimePrompt(input: {
  workspaceRoot: string;
  userText: string;
  editorFsReadAvailable: boolean;
  editorFileContext?: Array<{
    path: string;
    content: string;
  }>;
}): string {
  const explicitShellCommand = extractExplicitShellCommand(input.userText);
  const contextLines = [
    `ACP editor session for workspace: ${input.workspaceRoot}.`,
    input.editorFsReadAvailable
      ? "Editor-backed file access is available. If the user asks about workspace files such as package.json, README.md, or source files, use file.read instead of asking the user to paste the file contents."
      : "Editor-backed file access is not available in this ACP session.",
    "If the user explicitly asks to run a shell command, use terminal.run with the requested command instead of replying abstractly.",
    "If terminal.run is gated, let the ACP permission flow handle it. Do not silently end the turn before the permission request is emitted."
  ];

  if (explicitShellCommand !== undefined) {
    contextLines.push(`Explicit shell command requested by the user: ${explicitShellCommand}`);
  }

  const editorFileSection = input.editorFileContext === undefined || input.editorFileContext.length === 0
    ? []
    : [
        "",
        "[ACP Editor File Context]",
        ...input.editorFileContext.flatMap((file) => [
          `Path: ${file.path}`,
          "```",
          file.content,
          "```"
        ])
      ];

  return [
    "[ACP Session Context]",
    ...contextLines,
    ...editorFileSection,
    "",
    "[User Request]",
    input.userText
  ].join("\n");
}

function extractExplicitShellCommand(text: string): string | undefined {
  const fenced = text.match(/(?:^|\b)(?:run|execute)\s+`([^`]+)`/iu);
  if (fenced?.[1] !== undefined) {
    return fenced[1].trim();
  }

  const quoted = text.match(/(?:^|\b)(?:run|execute)\s+"([^"]+)"/iu);
  if (quoted?.[1] !== undefined) {
    return quoted[1].trim();
  }

  const plain = text.match(/(?:^|\b)(?:run|execute)\s+(.+?)(?=(?:\s+(?:and|then)\s+tell\b|[.!?]\s*$|$))/iu);
  if (plain?.[1] !== undefined) {
    const candidate = plain[1].trim();
    if (looksLikeShellCommand(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function shouldFallbackToExplicitShellExecution(
  response: AgentLoopResponse,
  explicitShellCommand: string | undefined
): explicitShellCommand is string {
  if (explicitShellCommand === undefined) {
    return false;
  }

  if (response.toolExecutions.length > 0 || response.toolPlans.length > 0) {
    return false;
  }

  return true;
}

function looksLikeShellCommand(text: string): boolean {
  return /[|&;><]/u.test(text) ||
    /\b(mkdir|rm|mv|cp|cat|echo|touch|ls|pwd|bun|npm|node|python|git|find|grep|rg|sed|awk|chmod|chown)\b/u.test(text);
}

function extractWorkspaceFileReferences(
  text: string,
  workspaceRoot: string
): Array<{
  absolutePath: string;
  relativePath: string;
}> {
  const matches = text.matchAll(/(?:^|[\s`'"])([A-Za-z0-9_./-]+\.[A-Za-z0-9_-]+)(?=$|[\s`'",.:;!?])/g);
  const seen = new Set<string>();
  const references: Array<{ absolutePath: string; relativePath: string }> = [];

  for (const match of matches) {
    const rawPath = match[1];
    if (typeof rawPath !== "string" || rawPath.length === 0) {
      continue;
    }
    const absolutePath = resolve(rawPath.startsWith("/") ? rawPath : join(workspaceRoot, rawPath));
    if (!isWithinWorkspace(workspaceRoot, absolutePath)) {
      continue;
    }
    const relativePath = relative(workspaceRoot, absolutePath) || rawPath;
    if (seen.has(relativePath)) {
      continue;
    }
    seen.add(relativePath);
    references.push({
      absolutePath,
      relativePath
    });
    if (references.length >= 3) {
      break;
    }
  }

  return references;
}

function isWithinWorkspace(workspaceRoot: string, candidate: string): boolean {
  const normalizedRoot = resolve(workspaceRoot);
  const normalizedCandidate = resolve(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}
