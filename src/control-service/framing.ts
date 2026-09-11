/** Byte bounds apply before decoding, including to unterminated input. */
export class BoundedLines {
  #parts: Buffer[] = [];
  #bytes = 0;
  #closed = false;
  constructor(readonly limit: number, readonly frame: (text: string) => void, readonly invalid: () => void) {}
  push(chunk: Buffer): void {
    if (this.#closed) return;
    let offset = 0;
    while (offset < chunk.length && !this.#closed) {
      const end = chunk.indexOf(10, offset);
      const stop = end < 0 ? chunk.length : end + 1;
      const part = chunk.subarray(offset, stop);
      if (this.#bytes + part.length > this.limit) { this.fail(); return; }
      this.#parts.push(Buffer.from(part)); this.#bytes += part.length;
      if (end >= 0) {
        const bytes = Buffer.concat(this.#parts, this.#bytes);
        this.#parts = []; this.#bytes = 0;
        let text: string;
        try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
        catch { this.fail(); return; }
        this.frame(text);
      }
      offset = stop;
    }
  }
  end(): void { if (this.#bytes) this.fail(); else this.dispose(); }
  dispose(): void { this.#closed = true; this.#parts = []; this.#bytes = 0; }
  private fail(): void { this.dispose(); this.invalid(); }
}
