import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import {verifyRuntimeInventory} from './runtime-integrity.js';
import type { Duplex, Readable, Writable } from 'node:stream';
export type ServiceTransport = { input: Writable; output: Readable; credentials: Duplex };
export function validateProfileId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value)) throw new Error('Invalid profile.');
}
export function ownedRuntime(root: string): { executable: string; entry: string } {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const executable = realpathSync(join(root, process.platform === 'win32' ? 'node.exe' : 'node'));
  const entry = realpathSync(join(root, 'core/dist/index.js'));
  const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  if (manifest.version !== 2 || manifest.platform !== process.platform || manifest.arch !== process.arch ||
      manifest.nodeSha256 !== hash(executable) || manifest.entrySha256 !== hash(entry)) throw new Error('Desktop runtime requires repair.');
  verifyRuntimeInventory(root,manifest);
  return { executable, entry };
}
/** Owns only a disposable bridge. No process-group kills or supervisor stop. */
export class ServiceProcess extends EventEmitter {
  #child: ChildProcess | null = null;
  #generation = 0;
  constructor(readonly runtimeRoot: string, readonly home: string) { super(); }
  start(profileId: string): ServiceTransport {
    validateProfileId(profileId); this.stop();
    const generation = ++this.#generation;
    const { executable, entry } = ownedRuntime(this.runtimeRoot);
    const child = spawn(executable, [entry, 'desktop-service', '--stdio', '--profile', profileId, '--credential-fd=3'], {
      cwd: this.runtimeRoot, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore', 'pipe'],
      env: { HOME: this.home, USERPROFILE: this.home, PATH: [dirname(executable), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter), LANG: 'en_US.UTF-8' },
    });
    this.#child = child;
    const ended = () => { if (this.#generation === generation) { this.#child = null; this.emit('disconnected'); } };
    child.once('error', ended); child.once('exit', ended);
    return { input: child.stdin!, output: child.stdout!, credentials: child.stdio[3] as Duplex };
  }
  stop(): void {
    ++this.#generation;
    const child = this.#child; this.#child = null;
    if (!child) return;
    child.stdin?.end(); (child.stdio[3] as Duplex | null)?.destroy();
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); }, 1500);
    timer.unref(); child.once('exit', () => clearTimeout(timer));
  }
}
