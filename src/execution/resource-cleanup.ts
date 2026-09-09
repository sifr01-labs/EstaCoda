/** Register cleanup immediately after construction. Every registered action is
 * attempted, in reverse order, even if an earlier action fails. */
export class ResourceCleanup {
  readonly #actions: Array<() => void | Promise<void>> = [];
  #closing?: Promise<void>;
  defer(action: () => void | Promise<void>): void {
    if (this.#closing) throw new Error("Resource cleanup already started.");
    this.#actions.push(action);
  }
  release(): Promise<void> {
    return this.#closing ??= (async () => {
      const errors: unknown[] = [];
      for (const action of this.#actions.splice(0).reverse()) {
        try { await action(); } catch (error) { errors.push(error); }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "Runtime resource cleanup failed.");
    })();
  }
}
