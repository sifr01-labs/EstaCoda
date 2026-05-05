import { describe, it, expect, beforeEach } from "vitest";
import {
  createCommandRegistry,
  commandRegistry,
} from "./command-registry.js";
import type { CommandRegistration } from "../contracts/command-registry.js";

describe("createCommandRegistry", () => {
  let registry: ReturnType<typeof createCommandRegistry>;

  beforeEach(() => {
    registry = createCommandRegistry();
  });

  it("registers and resolves a command by name", () => {
    registry.register({
      name: "status",
      aliases: [],
      category: "Info",
      description: "Show status",
      visibility: "public",
      scope: "slash",
    });
    expect(registry.resolve("status")?.name).toBe("status");
  });

  it("resolves a command by alias", () => {
    registry.register({
      name: "status",
      aliases: ["st", "info"],
      category: "Info",
      description: "Show status",
      visibility: "public",
      scope: "slash",
    });
    expect(registry.resolve("st")?.name).toBe("status");
    expect(registry.resolve("info")?.name).toBe("status");
  });

  it("returns undefined for unknown commands", () => {
    expect(registry.resolve("unknown")).toBeUndefined();
  });

  it("is case-insensitive in resolution", () => {
    registry.register({
      name: "Status",
      aliases: ["Info"],
      category: "Info",
      description: "Show status",
      visibility: "public",
      scope: "slash",
    });
    expect(registry.resolve("status")?.name).toBe("Status");
    expect(registry.resolve("info")?.name).toBe("Status");
  });

  it("lists all registered commands", () => {
    registry.register({
      name: "a",
      aliases: [],
      category: "X",
      description: "desc a",
      visibility: "public",
      scope: "cli",
    });
    registry.register({
      name: "b",
      aliases: [],
      category: "Y",
      description: "desc b",
      visibility: "public",
      scope: "slash",
    });
    const all = registry.list();
    expect(all).toHaveLength(2);
    expect(all.map((c) => c.name)).toContain("a");
    expect(all.map((c) => c.name)).toContain("b");
  });

  it("filters by scope", () => {
    registry.register({
      name: "cli-only",
      aliases: [],
      category: "X",
      description: "desc",
      visibility: "public",
      scope: "cli",
    });
    registry.register({
      name: "slash-only",
      aliases: [],
      category: "X",
      description: "desc",
      visibility: "public",
      scope: "slash",
    });
    registry.register({
      name: "both",
      aliases: [],
      category: "X",
      description: "desc",
      visibility: "public",
      scope: "both",
    });

    const cli = registry.list({ scope: "cli" });
    expect(cli.map((c) => c.name)).toContain("cli-only");
    expect(cli.map((c) => c.name)).toContain("both");
    expect(cli.map((c) => c.name)).not.toContain("slash-only");

    const slash = registry.list({ scope: "slash" });
    expect(slash.map((c) => c.name)).toContain("slash-only");
    expect(slash.map((c) => c.name)).toContain("both");
    expect(slash.map((c) => c.name)).not.toContain("cli-only");
  });

  it("filters by visibility", () => {
    registry.register({
      name: "public",
      aliases: [],
      category: "X",
      description: "desc",
      visibility: "public",
      scope: "cli",
    });
    registry.register({
      name: "hidden",
      aliases: [],
      category: "X",
      description: "desc",
      visibility: "hidden",
      scope: "cli",
    });
    registry.register({
      name: "debug",
      aliases: [],
      category: "X",
      description: "desc",
      visibility: "debug",
      scope: "cli",
    });

    const publicOnly = registry.list({ visibility: "public" });
    expect(publicOnly).toHaveLength(1);
    expect(publicOnly[0].name).toBe("public");
  });

  it("filters by text filter matching name", () => {
    registry.register({
      name: "status",
      aliases: [],
      category: "Info",
      description: "Show status",
      visibility: "public",
      scope: "slash",
    });
    registry.register({
      name: "tools",
      aliases: [],
      category: "Info",
      description: "Browse tools",
      visibility: "public",
      scope: "slash",
    });

    const filtered = registry.list({ filter: "stat" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe("status");
  });

  it("filters by text filter matching description", () => {
    registry.register({
      name: "a",
      aliases: [],
      category: "X",
      description: "Show status",
      visibility: "public",
      scope: "slash",
    });
    registry.register({
      name: "b",
      aliases: [],
      category: "X",
      description: "Browse tools",
      visibility: "public",
      scope: "slash",
    });

    const filtered = registry.list({ filter: "browse" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe("b");
  });

  it("filters by text filter matching alias", () => {
    registry.register({
      name: "status",
      aliases: ["st"],
      category: "Info",
      description: "Show status",
      visibility: "public",
      scope: "slash",
    });

    const filtered = registry.list({ filter: "st" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe("status");
  });

  it("filters by text filter matching category", () => {
    registry.register({
      name: "a",
      aliases: [],
      category: "Security",
      description: "desc",
      visibility: "public",
      scope: "slash",
    });
    registry.register({
      name: "b",
      aliases: [],
      category: "Info",
      description: "desc",
      visibility: "public",
      scope: "slash",
    });

    const filtered = registry.list({ filter: "security" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe("a");
  });

  it("combines scope and filter", () => {
    registry.register({
      name: "status",
      aliases: [],
      category: "Info",
      description: "Show status",
      visibility: "public",
      scope: "slash",
    });
    registry.register({
      name: "model",
      aliases: [],
      category: "Info",
      description: "Show model",
      visibility: "public",
      scope: "cli",
    });

    const filtered = registry.list({ scope: "slash", filter: "stat" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe("status");
  });

  it("returns categories", () => {
    registry.register({
      name: "a",
      aliases: [],
      category: "Z",
      description: "desc",
      visibility: "public",
      scope: "cli",
    });
    registry.register({
      name: "b",
      aliases: [],
      category: "A",
      description: "desc",
      visibility: "public",
      scope: "cli",
    });

    expect(registry.getCategories()).toEqual(["A", "Z"]);
  });

  it("returns categories scoped to a scope", () => {
    registry.register({
      name: "cli-only",
      aliases: [],
      category: "Setup",
      description: "desc",
      visibility: "public",
      scope: "cli",
    });
    registry.register({
      name: "slash-only",
      aliases: [],
      category: "Session",
      description: "desc",
      visibility: "public",
      scope: "slash",
    });
    registry.register({
      name: "both",
      aliases: [],
      category: "System",
      description: "desc",
      visibility: "public",
      scope: "both",
    });

    expect(registry.getCategories("cli")).toEqual(["Setup", "System"]);
    expect(registry.getCategories("slash")).toEqual(["Session", "System"]);
  });

  it("returns empty list when no commands match filter", () => {
    registry.register({
      name: "a",
      aliases: [],
      category: "X",
      description: "desc",
      visibility: "public",
      scope: "cli",
    });
    expect(registry.list({ filter: "zzzz" })).toHaveLength(0);
  });
});

describe("global commandRegistry", () => {
  it("has slash commands pre-registered", () => {
    expect(commandRegistry.resolve("help")?.scope).toBe("both");
    expect(commandRegistry.resolve("status")?.scope).toBe("slash");
    expect(commandRegistry.resolve("model")?.scope).toBe("both");
    expect(commandRegistry.resolve("exit")?.scope).toBe("slash");
  });

  it("has CLI commands pre-registered", () => {
    expect(commandRegistry.resolve("setup")?.scope).toBe("cli");
    expect(commandRegistry.resolve("verify")?.scope).toBe("cli");
    expect(commandRegistry.resolve("tools")?.scope).toBe("both");
  });

  it("has cron subcommands pre-registered", () => {
    expect(commandRegistry.resolve("add")?.category).toBe("Cron");
    expect(commandRegistry.resolve("create")?.name).toBe("add"); // alias
    expect(commandRegistry.resolve("list")?.category).toBe("Cron");
    expect(commandRegistry.resolve("pause")?.category).toBe("Cron");
  });

  it("lists all slash commands", () => {
    const slash = commandRegistry.list({ scope: "slash" });
    const names = slash.map((c) => c.name);
    expect(names).toContain("help");
    expect(names).toContain("status");
    expect(names).toContain("model");
    expect(names).toContain("exit");
    expect(names).toContain("yolo");
    expect(names).toContain("cron");
  });

  it("lists all CLI commands", () => {
    const cli = commandRegistry.list({ scope: "cli" });
    const names = cli.map((c) => c.name);
    expect(names).toContain("setup");
    expect(names).toContain("verify");
    expect(names).toContain("trace");
    expect(names).toContain("eval");
  });

  it("does not include duplicate entries for both-scope commands", () => {
    const all = commandRegistry.list();
    const names = all.map((c) => c.name);
    const uniqueNames = [...new Set(names)];
    expect(names.length).toBe(uniqueNames.length);
  });
});
