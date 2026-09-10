import type { ExecutionFacts } from "./execution-authority.js";
import { EditorContentView, type ExecutionContentView } from "./editor-content-view.js";
import { HostProcessScope, type HostProcesses } from "./host-processes.js";
import { HostWorkspaceFiles, type WorkspaceFiles } from "./host-workspace-files.js";
import { randomUUID } from "node:crypto";
import type { HostExecutionFacts, RequestedExecutionPolicy } from "../contracts/execution-authority.js";
import { verifyHostExecution } from "./host-authority.js";

export type ExecutionScopeContext = Readonly<{
  profileId: string;
  sessionId: string;
  surface: string;
  taskId?: string;
  attemptId?: string;
  parentScopeId?: string;
}>;
export type OwnedExecutionResource = { release(): void | Promise<void> };

type Scope = {
  id: string;
  context: ExecutionScopeContext;
  controller: AbortController;
  resources: Set<OwnedExecutionResource>;
  processes: HostProcesses & OwnedExecutionResource;
  borrowers: number;
  closing?: Promise<void>;
};

/** A prepared host view can serve independent scopes. It is not an OS sandbox
 * or the persisted, exclusive Session execution owner introduced in PR 4. */
export class HostEnvironment {
  readonly facts: Readonly<ExecutionFacts>;
  readonly profileId: string;
  readonly #content: EditorContentView;
  readonly #driver?: { files(assertActive: () => void, processes?: HostProcesses): WorkspaceFiles; processes(): HostProcesses & OwnedExecutionResource; dispose(): Promise<void> };
  readonly #scopes = new Set<Scope>();
  #retainers = 0;
  #destroyed = false;
  #retireCleanup?: () => Promise<void>;
  #retiring?: Promise<void>;

  /** The runtime owner detaches; independent scopes retain shared providers until idle. */
  async retire(cleanup: () => Promise<void>): Promise<void> {
    this.#retireCleanup ??= cleanup;
    await this.#finishRetirement();
  }

  async #finishRetirement(): Promise<void> {
    if (this.#scopes.size || this.#retainers || !this.#retireCleanup) return;
    this.#destroyed = true;
    this.#retiring ??= Promise.resolve().then(() => this.#driver?.dispose()).then(this.#retireCleanup);
    await this.#retiring;
  }

  private constructor(profileId: string, facts: Readonly<ExecutionFacts>, driver?: EnvironmentDriver) {
    this.#driver = driver;
    this.profileId = profileId;
    this.facts = facts;
    const active = () => { if (this.#destroyed) throw new Error("Execution environment has been destroyed."); };
    this.#content = new EditorContentView(driver ? driver.files(active) : new HostWorkspaceFiles(facts.workspace.canonicalPath, active), facts.workspace.canonicalPath);
  }

  static prepared(profileId: string, facts: Readonly<ExecutionFacts>, driver: EnvironmentDriver): HostEnvironment {
    return new HostEnvironment(profileId, facts, driver);
  }

  static async create(input: { profileId: string; workspaceRoot: string; policy?: RequestedExecutionPolicy }): Promise<HostEnvironment> {
    if (!input.profileId.trim()) throw new Error("Execution requires a profile.");
    return new HostEnvironment(input.profileId, await verifyHostExecution(input.workspaceRoot, input.policy));
  }

  acquire(context: ExecutionScopeContext): HostExecutionLease {
    if (this.#destroyed || context.profileId !== this.profileId || !context.sessionId.trim() || !context.surface.trim()) {
      throw new Error("Execution scope is unavailable or belongs to another profile.");
    }
    const scope: Scope = { id: `scope_${randomUUID()}`, context: Object.freeze({ ...context }),
      controller: new AbortController(), resources: new Set(), processes: this.#driver?.processes() ?? new HostProcessScope(this.facts.workspace.canonicalPath), borrowers: 0 };
    scope.resources.add(scope.processes);
    this.#scopes.add(scope);
    return this.#borrow(scope);
  }

  #borrow(scope: Scope): HostExecutionLease {
    if (scope.closing || this.#destroyed) throw new Error("Execution scope has been released.");
    scope.borrowers++;
    let released = false;
    const assertActive = () => {
      if (released || scope.controller.signal.aborted || this.#destroyed) throw new Error("Execution lease has been released.");
    };
    return {
      content: {
        read: (path, reader) => { assertActive(); return this.#content.read(path, reader); },
        isMaterialized: (path) => { assertActive(); return this.#content.isMaterialized(path); },
        assertMaterialized: () => { assertActive(); return this.#content.assertMaterialized(); }
      },
      processes: {
        environment: (options) => { assertActive(); return scope.processes.environment(options); },
        spawn: (command, args, options) => { assertActive(); return scope.processes.spawn(command, args, options); },
        terminate: (child, signal) => scope.processes.terminate(child, signal)
      },
      files: this.#driver?.files(assertActive, scope.processes) ?? new HostWorkspaceFiles(this.facts.workspace.canonicalPath, assertActive),
      scopeId: scope.id, context: scope.context, facts: this.facts,
      workspaceRoot: this.facts.workspace.canonicalPath, signal: scope.controller.signal,
      assertActive,
      borrow: () => { assertActive(); return this.#borrow(scope); },
      retainEnvironment: () => {
        assertActive(); this.#retainers++;
        let released = false;
        return async () => {
          if (!released) { released = true; this.#retainers--; }
          await this.#finishRetirement();
        };
      },
      child: (context) => { assertActive(); return this.acquire({ ...context, parentScopeId: scope.id }); },
      own: (resource) => {
        assertActive(); scope.resources.add(resource);
        return () => { scope.resources.delete(resource); };
      },
      release: async () => {
        if (released) { await scope.closing; return; }
        released = true;
        if (--scope.borrowers > 0) return;
        scope.controller.abort(new Error("Execution scope released."));
        scope.closing = (async () => {
          const results = await Promise.allSettled([...scope.resources].map((resource) => Promise.resolve().then(() => resource.release())));
          scope.resources.clear();
          const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
          if (errors.length) throw new AggregateError(errors.map((result) => result.reason), "Execution resource cleanup failed.");
          this.#scopes.delete(scope);
          await this.#finishRetirement();
        })();
        await scope.closing;
      }
    };
  }

  destroy(): void | Promise<void> {
    if (this.#scopes.size || this.#retainers) throw new Error("Execution environment still has borrowed or settling scopes.");
    this.#destroyed = true;
    return this.#driver?.dispose();
  }
}

export type HostExecutionLease = {
  readonly content: ExecutionContentView;
  readonly processes: HostProcesses;
  readonly files: WorkspaceFiles;
  readonly scopeId: string;
  readonly context: ExecutionScopeContext;
  readonly facts: Readonly<ExecutionFacts>;
  readonly workspaceRoot: string;
  readonly signal: AbortSignal;
  assertActive(): void;
  borrow(): HostExecutionLease;
  /** Keep shared state alive through owner settlement; grants no execution access. */
  retainEnvironment(): () => Promise<void>;
  child(context: Omit<ExecutionScopeContext, "parentScopeId">): HostExecutionLease;
  own(resource: OwnedExecutionResource): () => void;
  release(): Promise<void>;
};

type EnvironmentDriver = { files(assertActive: () => void, processes?: HostProcesses): WorkspaceFiles; processes(): HostProcesses & OwnedExecutionResource; dispose(): Promise<void> };
/** Compatibility export: both host and Docker implement this owned lease contract. */
export type ExecutionLease = HostExecutionLease;
