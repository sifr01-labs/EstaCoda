export type CommandVisibility = "public" | "hidden" | "debug";
export type CommandScope = "cli" | "slash" | "both";

export interface CommandRegistration {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly category: string;
  readonly description: string;
  readonly visibility: CommandVisibility;
  readonly scope: CommandScope;
  readonly parent?: string;
}

export interface CommandRegistry {
  register(command: CommandRegistration): void;
  resolve(name: string): CommandRegistration | undefined;
  resolveSubcommand(parent: string, name: string): CommandRegistration | undefined;
  list(options?: {
    scope?: CommandScope;
    visibility?: CommandVisibility;
    filter?: string;
    parent?: string | null;
  }): readonly CommandRegistration[];
  getCategories(scope?: CommandScope): readonly string[];
}
