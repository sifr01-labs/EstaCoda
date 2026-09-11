import { randomUUID } from 'node:crypto';
import { ControlProtocolError, assertBoundedJson, exactKeys, isControlId, isRecord } from '../contracts/desktop-control/index.js';
export type CandidateScope = { windowId: string; generation: number; purpose: 'provider' | 'telegram'; providerId: string; authMethod: 'api_key' | 'oauth'; endpoint: string };
type Candidate = { abort: AbortController; scope: CandidateScope; value: string; absolute: number; idle: number; timer: ReturnType<typeof setTimeout> };
export function validateCandidateScope(value: unknown): asserts value is CandidateScope {
  assertBoundedJson(value);
  if (!isRecord(value) || !exactKeys(value, ['windowId', 'generation', 'purpose', 'providerId', 'authMethod', 'endpoint']) ||
    !isControlId(value.windowId) || !isControlId(value.providerId) || !Number.isSafeInteger(value.generation) || Number(value.generation) < 1 ||
    !['provider', 'telegram'].includes(String(value.purpose)) || !['api_key', 'oauth'].includes(String(value.authMethod)) ||
    typeof value.endpoint !== 'string' || value.endpoint.length > 2_048) throw new ControlProtocolError('-32602');
  let url: URL;
  try { url = new URL(value.endpoint); } catch { throw new ControlProtocolError('-32602'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new ControlProtocolError('-32602');
  if (value.purpose === 'telegram' && (value.providerId !== 'telegram' || value.authMethod !== 'api_key' || value.endpoint !== 'https://api.telegram.org')) throw new ControlProtocolError('-32602');
}
/** Memory only. This does not verify credentials, authorize apply or write configuration. */
export class CredentialCandidates {
  readonly #entries = new Map<string, Candidate>();
  readonly #windows = new Map<string, { generation: number; closed: boolean }>();
  #closed = false;
  constructor(readonly profileId: string, readonly instanceId: string, readonly now = () => performance.now()) {}
  stage(scope: CandidateScope, value: string): string {
    validateCandidateScope(scope);
    if (this.#closed || typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 49_152) throw new ControlProtocolError('-32602');
    const window = this.#windows.get(scope.windowId);
    if (window && (scope.generation < window.generation || (scope.generation === window.generation && window.closed))) throw new ControlProtocolError('-32003');
    if (!window && this.#windows.size >= 64) throw new ControlProtocolError('-32009');
    if (window && scope.generation > window.generation) this.removeWindow(scope.windowId);
    this.#windows.set(scope.windowId, { generation: scope.generation, closed: false });
    this.expire();
    if (this.#entries.size >= 32 || [...this.#entries.values()].filter((entry) => entry.scope.windowId === scope.windowId).length >= 8) throw new ControlProtocolError('-32009');
    const id = randomUUID(), now = this.now();
    const entry: Candidate = { abort: new AbortController(), scope: structuredClone(scope), value, absolute: now + 900_000, idle: now + 300_000,
      timer: setTimeout(() => this.alarm(id), 300_000) };
    entry.timer.unref(); this.#entries.set(id, entry); return id;
  }
  /** Trusted backend use only; the pipe and ordinary RPC never expose this value. */
  read(id: string, scope: CandidateScope): string {
    const entry = this.require(id, scope);
    entry.idle = Math.min(this.now() + 300_000, entry.absolute);
    clearTimeout(entry.timer); entry.timer = setTimeout(() => this.alarm(id), Math.max(1, entry.idle - this.now())); entry.timer.unref();
    return entry.value;
  }
  signal(id: string, scope: CandidateScope): AbortSignal { return this.require(id, scope).abort.signal; }
  discard(id: string, scope: CandidateScope): void { this.require(id, scope); this.remove(id); }
  closeWindow(windowId: string, generation: number): void {
    if (!isControlId(windowId) || !Number.isSafeInteger(generation) || generation < 1 || this.#closed) throw new ControlProtocolError('-32602');
    const window = this.#windows.get(windowId);
    if (window && generation < window.generation) throw new ControlProtocolError('-32003');
    if (!window && this.#windows.size >= 64) throw new ControlProtocolError('-32009');
    this.#windows.set(windowId, { generation, closed: true }); this.removeWindow(windowId);
  }
  dispose(): void { this.#closed = true; for (const id of this.#entries.keys()) this.remove(id); this.#windows.clear(); }
  private require(id: string, scope: CandidateScope): Candidate {
    validateCandidateScope(scope); this.expire();
    const entry = this.#entries.get(id);
    if (!entry || this.#closed || Object.keys(scope).some((key) => scope[key as keyof CandidateScope] !== entry.scope[key as keyof CandidateScope])) throw new ControlProtocolError('-32003');
    return entry;
  }
  private alarm(id: string): void {
    const entry = this.#entries.get(id); if (!entry) return;
    const remaining = Math.min(entry.idle, entry.absolute) - this.now();
    if (remaining <= 0) this.remove(id);
    else { entry.timer = setTimeout(() => this.alarm(id), Math.max(1, Math.ceil(remaining))); entry.timer.unref(); }
  }
  private expire(): void { for (const id of this.#entries.keys()) this.discardExpired(id); }
  private discardExpired(id: string): void { const entry = this.#entries.get(id); if (entry && this.now() >= Math.min(entry.idle, entry.absolute)) this.remove(id); }
  private remove(id: string): void { const entry = this.#entries.get(id); if (entry) { entry.abort.abort(); clearTimeout(entry.timer); this.#entries.delete(id); } }
  private removeWindow(windowId: string): void { for (const [id, entry] of this.#entries) if (entry.scope.windowId === windowId) this.remove(id); }
}
