import { describe, it, expect } from "vitest";
import { resolveTokens } from "../theme/token-resolver.js";
import type { TerminalCapabilities } from "../contracts/ui.js";
import type { ViewModel } from "../contracts/view-model.js";
import {
  buildSlashMenuViewModel,
  buildSlashCompletionViewModel,
  buildSkillsMenuViewModel,
  buildToolsMenuViewModel,
  renderSlashCompletion,
  renderSlashMenu,
  renderToolsMenu,
} from "./slash-menu.js";
import { buildSessionHelpViewModel, renderSessionHelp } from "./session-help.js";
import { createSessionRenderer } from "./session-renderer.js";
import { StandardRenderer } from "../ui/renderers/standard-renderer.js";
import { renderPlain } from "../ui/renderers/plain-renderer.js";
import { stripAnsi } from "../ui/renderers/layout.js";
import { buildStartupViewModel, buildPickerViewModel, buildAssistantResponseViewModel, buildStartupDashboardViewModel, buildUserPromptRailViewModel } from "../ui/view-models/builders.js";
import { renderBottomChromeRule, renderHorizontalRule, colorPromptPrefix } from "./session-loop.js";

// ──────────────────────────────────────
// Rendering context factories
// ──────────────────────────────────────

function fullCaps(): TerminalCapabilities {
  return {
    isTTY: true,
    supportsColor: true,
    supportsTrueColor: true,
    supportsUnicode: true,
    supportsEmoji: true,
    terminalWidth: 120,
    isDumb: false,
    isCI: false,
    supportsAnimation: true,
  };
}

function noColorCaps(): TerminalCapabilities {
  return {
    ...fullCaps(),
    supportsColor: false,
    supportsTrueColor: false,
  };
}

function noUnicodeCaps(): TerminalCapabilities {
  return {
    ...fullCaps(),
    supportsUnicode: false,
    supportsEmoji: false,
  };
}

function plainCaps(): TerminalCapabilities {
  return {
    isTTY: false,
    supportsColor: false,
    supportsTrueColor: false,
    supportsUnicode: false,
    supportsEmoji: false,
    terminalWidth: 80,
    isDumb: true,
    isCI: false,
    supportsAnimation: false,
  };
}

function narrowCaps(): TerminalCapabilities {
  return {
    ...fullCaps(),
    terminalWidth: 40,
  };
}

function ciCaps(): TerminalCapabilities {
  return {
    ...fullCaps(),
    isCI: true,
    supportsAnimation: false,
  };
}

function dumbCaps(): TerminalCapabilities {
  return {
    ...fullCaps(),
    isDumb: true,
    supportsAnimation: false,
  };
}

function nonTtyCaps(): TerminalCapabilities {
  return {
    ...fullCaps(),
    isTTY: false,
    supportsAnimation: false,
  };
}

// ──────────────────────────────────────
// Renderer factories per context
// ──────────────────────────────────────

function standardDarkRenderer() {
  const tokens = resolveTokens("standard", "dark", "kemetBlue");
  return new StandardRenderer({ tokens, capabilities: fullCaps() });
}

function standardLightRenderer() {
  const tokens = resolveTokens("standard", "light", "kemetBlue");
  return new StandardRenderer({ tokens, capabilities: fullCaps() });
}

function noColorRenderer() {
  const tokens = resolveTokens("standard", "dark", "kemetBlue");
  return new StandardRenderer({ tokens, capabilities: noColorCaps() });
}

function noUnicodeRenderer() {
  const tokens = resolveTokens("standard", "dark", "kemetBlue");
  return new StandardRenderer({ tokens, capabilities: noUnicodeCaps() });
}

function narrowRenderer() {
  const tokens = resolveTokens("standard", "dark", "kemetBlue");
  return new StandardRenderer({ tokens, capabilities: narrowCaps() });
}

function plainRenderer() {
  return { render: renderPlain };
}

// ──────────────────────────────────────
// Fake runtime for /status and /model
// ──────────────────────────────────────

function fakeStatusViewModel(): ViewModel {
  return {
    kind: "status",
    agentName: "EstaCoda",
    model: { provider: "unconfigured", id: "smoke-model" },
    securityMode: "adaptive",
    skillCount: 3,
    skillAutonomy: "suggest",
    toolCount: 12,
    mcp: { active: 1, total: 2 },
    workflowAvailable: false,
    workflowRunActive: false,
    warnings: [],
  };
}

function fakeModelInfoViewModel(): ViewModel {
  return {
    kind: "kv",
    title: "Model",
    entries: [
      { key: "provider", value: "unconfigured" },
      { key: "model", value: "smoke-model" },
      { key: "context window", value: "unknown" },
      { key: "security mode", value: "adaptive" },
    ],
  };
}

// Fake runtime interface for menu builders
const fakeRuntime = {
  tools: () => [],
  skills: () => [],
} as unknown as Parameters<typeof buildSlashMenuViewModel>[0];

const fakeToolsRuntime = {
  tools: () => [
    {
      name: "workspace_search",
      description: "Search files in the current workspace for code, documentation, and configuration references.",
      toolsets: ["files", "coding", "research"],
    },
    {
      name: "apply_patch",
      description: "Apply a focused patch to files in the trusted workspace.",
      toolsets: ["files", "coding"],
    },
    {
      name: "terminal_inspect",
      description: "Inspect terminal output and command state without mutating the workspace.",
      toolsets: ["shell-readonly", "coding", "research"],
    },
  ],
} as unknown as Parameters<typeof buildToolsMenuViewModel>[0];

const fakeSkillsRuntime = {
  tools: () => [],
  skills: () => [
    {
      name: "batch",
      description: "Research and plan a large-scale codebase change with verification recipes.",
      category: "software-development",
      sourceKind: "bundled",
    },
    {
      name: "ascii-video",
      description: "Create ASCII art videos and generative terminal-style motion pieces.",
      category: "media",
      sourceKind: "bundled",
    },
    {
      name: "remember",
      description: "Review memory entries and propose cleanup, deduplication, and conflict fixes.",
      category: "productivity",
      sourceKind: "local",
    },
  ],
} as unknown as Parameters<typeof buildSkillsMenuViewModel>[0];

// ──────────────────────────────────────
// Snapshot helpers
// ──────────────────────────────────────

function snapshotContexts() {
  return [
    { name: "plain", renderer: plainRenderer() },
    { name: "standard dark", renderer: standardDarkRenderer() },
    { name: "standard light", renderer: standardLightRenderer() },
    { name: "no color", renderer: noColorRenderer() },
    { name: "no Unicode", renderer: noUnicodeRenderer() },
    { name: "narrow width", renderer: narrowRenderer() },
  ];
}

function snapshotOutput(output: string): string {
  return output.split("\n").map((line) => line.trimEnd()).join("\n");
}

// ──────────────────────────────────────
// Test suites
// ──────────────────────────────────────

describe("Session surfaces — /status", () => {
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const output = ctx.renderer.render(fakeStatusViewModel());
      expect(snapshotOutput(output)).toMatchSnapshot(`status-${ctx.name}`);
    });
  }
});

describe("Session surfaces — /model", () => {
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const output = ctx.renderer.render(fakeModelInfoViewModel());
      expect(snapshotOutput(output)).toMatchSnapshot(`model-${ctx.name}`);
    });
  }
});

describe("Session surfaces — /help", () => {
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const vm = buildSessionHelpViewModel();
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`help-${ctx.name}`);
    });
  }
});

describe("Session surfaces — /tools", () => {
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const vm = buildToolsMenuViewModel(fakeRuntime, "");
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`tools-${ctx.name}`);
    });
  }

  it("renders one alphabetic tools table without grouping duplicates", () => {
    const output = renderPlain(buildToolsMenuViewModel(fakeToolsRuntime, ""));
    const applyPatchIndex = output.indexOf("apply_patch");
    const terminalIndex = output.indexOf("terminal_inspect");
    const workspaceSearchIndex = output.indexOf("workspace_search");

    expect(output).toContain("[OK] Tools: 3");
    expect(output).toContain("Available tools");
    expect(output).toContain("Name");
    expect(output).toContain("Description");
    expect(output).toContain("[files, coding]");
    expect(output).toContain("...");
    expect(output).not.toContain("files tools");
    expect(output).not.toContain("coding tools");
    expect(output.match(/workspace_search/g)).toHaveLength(1);
    expect(applyPatchIndex).toBeGreaterThan(-1);
    expect(terminalIndex).toBeGreaterThan(applyPatchIndex);
    expect(workspaceSearchIndex).toBeGreaterThan(terminalIndex);
  });

  it("renders tool names bold in the standard renderer without bolding descriptions", () => {
    const output = standardDarkRenderer().render(buildToolsMenuViewModel(fakeToolsRuntime, "apply"));

    expect(output).toContain("\x1b[1mapply_patch");
    expect(output).not.toContain("\x1b[1mApply a focused");
  });

  it("filters tools by name, description, and toolset", () => {
    const byToolset = renderPlain(buildToolsMenuViewModel(fakeToolsRuntime, "shell-readonly"));
    expect(byToolset).toContain("terminal_inspect");
    expect(byToolset).not.toContain("workspace_search");

    const byDescription = renderPlain(buildToolsMenuViewModel(fakeToolsRuntime, "trusted workspace"));
    expect(byDescription).toContain("apply_patch");
    expect(byDescription).not.toContain("terminal_inspect");
  });

  it("renders distinct empty states for missing tools and missing matches", () => {
    expect(renderPlain(buildToolsMenuViewModel(fakeRuntime, ""))).toBe("- No tools are available.");
    expect(renderPlain(buildToolsMenuViewModel(fakeToolsRuntime, "nonexistent"))).toBe('- No tools match "nonexistent".');
  });
});

describe("Session surfaces — /skills", () => {
  it("renders only skills in the same table style as tools", () => {
    const output = renderPlain(buildSkillsMenuViewModel(fakeSkillsRuntime, ""));

    expect(output).toContain("[OK] Skills: 3");
    expect(output).toContain("Available skills");
    expect(output).toContain("Name");
    expect(output).toContain("Description");
    expect(output).toContain("/ascii-video");
    expect(output).toContain("/batch");
    expect(output).toContain("[media/bundled]");
    expect(output).toContain("...");
    expect(output).not.toContain("verification recipes. [software-development/bundled]");
    expect(output).not.toContain("Commands");
    expect(output).not.toContain("/help");
    expect(output).not.toContain("/exit");
  });

  it("renders skill names bold in the standard renderer without bolding descriptions", () => {
    const output = standardDarkRenderer().render(buildSkillsMenuViewModel(fakeSkillsRuntime, "media"));

    expect(output).toContain("\x1b[1m/ascii-video");
    expect(output).not.toContain("\x1b[1mCreate ASCII");
  });

  it("filters skills by name, description, category, and source", () => {
    const byCategory = renderPlain(buildSkillsMenuViewModel(fakeSkillsRuntime, "media"));
    expect(byCategory).toContain("/ascii-video");
    expect(byCategory).not.toContain("/batch");

    const bySource = renderPlain(buildSkillsMenuViewModel(fakeSkillsRuntime, "local"));
    expect(bySource).toContain("/remember");
    expect(bySource).not.toContain("/ascii-video");

    const byDescription = renderPlain(buildSkillsMenuViewModel(fakeSkillsRuntime, "verification"));
    expect(byDescription).toContain("/batch");
    expect(byDescription).not.toContain("/remember");
  });

  it("renders distinct empty states for missing skills and missing matches", () => {
    expect(renderPlain(buildSkillsMenuViewModel(fakeRuntime, ""))).toBe("- No skills are available.");
    expect(renderPlain(buildSkillsMenuViewModel(fakeSkillsRuntime, "nonexistent"))).toBe('- No skills match "nonexistent".');
  });
});

describe("Session surfaces — slash menu", () => {
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const vm = buildSlashMenuViewModel(fakeRuntime, "");
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`slash-menu-${ctx.name}`);
    });
  }
});

describe("Session surfaces — slash completion list", () => {
  it("renders lightweight command rows without table chrome", () => {
    const vm = buildSlashCompletionViewModel(fakeRuntime, "/");
    const output = standardDarkRenderer().render(vm);
    expect(output).toContain("/help");
    expect(output).toContain("Show command help");
    expect(output).toContain("/status");
    expect(output).not.toContain("Commands");
    expect(output).not.toContain("Name");
    expect(output).not.toContain("Description");
    expect(output).not.toContain("𓂀");
  });

  it("filters partial slash input", () => {
    const vm = buildSlashCompletionViewModel(fakeRuntime, "/mo");
    const output = renderPlain(vm);
    expect(output).toContain("/model");
    expect(output).toContain("Show active model");
    expect(output).not.toContain("/help");
  });

  it("renders readable empty state for unknown slash input", () => {
    const vm = buildSlashCompletionViewModel(fakeRuntime, "/zzzz");
    expect(renderPlain(vm)).toBe('No slash commands match "/zzzz".');
  });

  it("keeps completion commands limited to implemented slash commands", () => {
    const all = buildSlashCompletionViewModel(fakeRuntime, "/", { limit: 100 });
    const labels = all.options.map((option) => option.label);
    expect(labels).toContain("/tools");
    expect(labels).toContain("/exit");
    expect(labels).not.toContain("/version");
    expect(labels).not.toContain("/packs");
  });

  it("caps slash completion rows without changing priority order", () => {
    const vm = buildSlashCompletionViewModel(fakeRuntime, "/", { limit: 3 });
    expect(vm.options.map((option) => option.label)).toEqual(["/help", "/status", "/model"]);

    const output = standardDarkRenderer().render(vm);
    expect(output).toContain("/help");
    expect(output).toContain("/status");
    expect(output).toContain("/model");
    expect(output).not.toContain("/tools");
  });

  it("renders windowed slash completion rows beyond the first page", () => {
    const vm = buildSlashCompletionViewModel(fakeRuntime, "/", { selectedIndex: 4, visibleRows: 3 });
    const output = standardDarkRenderer().render(vm);

    expect(vm.options.map((option) => option.label)).toEqual(["/tools", "/skills", "/exit"]);
    expect(stripAnsi(output)).toContain("> /skills");
    expect(output).not.toContain("/help");
  });

  it("marks the selected slash completion row in plain output", () => {
    const vm = buildSlashCompletionViewModel(fakeRuntime, "/", { selectedIndex: 1, visibleRows: 3 });
    const output = renderPlain(vm);

    expect(output).toContain("> /status");
    expect(output).toContain("  /help");
  });

  it("keeps /tools as its own command behavior", () => {
    const completion = renderPlain(buildSlashCompletionViewModel(fakeRuntime, "/tools"));
    const toolsOutput = renderPlain(buildToolsMenuViewModel(fakeRuntime, ""));
    expect(completion).toContain("/tools");
    expect(completion).toContain("Browse runtime tools");
    expect(toolsOutput).toContain("No tools are available.");
  });

  it("renders no-color and no-Unicode fallbacks without ANSI or ceremonial chrome", () => {
    const vm = buildSlashCompletionViewModel(fakeRuntime, "/");
    const noColorOutput = noColorRenderer().render(vm);
    const noUnicodeOutput = noUnicodeRenderer().render(vm);
    expect(noColorOutput).not.toMatch(/\x1b\[/);
    expect(noColorOutput).toContain("/help");
    expect(noUnicodeOutput).not.toContain("𓂀");
    expect(noUnicodeOutput).toContain("/help");
  });

  it("renders Arabic descriptions with isolated slash commands", () => {
    const renderer = createSessionRenderer({ capabilities: fullCaps(), locale: "ar" });
    const output = renderer.render(buildSlashCompletionViewModel(fakeRuntime, "/"));
    expect(output).toContain("\u2066/help\u2069");
    expect(output).toContain("اعرض مساعدة الأوامر");
    expect(output).toContain("\u2066/status\u2069");
    expect(output).toContain("اعرض حالة التشغيل والنموذج والسياق والجلسة");
  });

  it("renderSlashCompletion still returns deterministic plain text", () => {
    const output = renderSlashCompletion(fakeRuntime, "/mo");
    expect(output).toContain("/model");
    expect(output).not.toMatch(/\x1b\[/);
  });
});

describe("Session surfaces — unknown-command fallback", () => {
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const vm = buildSlashMenuViewModel(fakeRuntime, "nonexistent");
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`unknown-command-${ctx.name}`);
    });
  }
});

// ──────────────────────────────────────
// SessionRenderer factory selection logic
// ──────────────────────────────────────

describe("createSessionRenderer — selection logic", () => {
  it("returns plain renderer for non-TTY output", () => {
    const renderer = createSessionRenderer({ capabilities: nonTtyCaps() });
    const vm = fakeStatusViewModel();
    const output = renderer.render(vm);
    expect(output).not.toMatch(/\x1b\[/);
  });

  it("returns plain renderer for CI environment", () => {
    const renderer = createSessionRenderer({ capabilities: ciCaps() });
    const vm = fakeStatusViewModel();
    const output = renderer.render(vm);
    expect(output).not.toMatch(/\x1b\[/);
  });

  it("returns plain renderer for dumb terminal", () => {
    const renderer = createSessionRenderer({ capabilities: dumbCaps() });
    const vm = fakeStatusViewModel();
    const output = renderer.render(vm);
    expect(output).not.toMatch(/\x1b\[/);
  });

  it("returns plain renderer for no-color caps", () => {
    const renderer = createSessionRenderer({ capabilities: noColorCaps() });
    const vm = fakeStatusViewModel();
    const output = renderer.render(vm);
    expect(output).not.toMatch(/\x1b\[/);
  });

  it("returns standard renderer for full TTY caps", () => {
    const renderer = createSessionRenderer({ capabilities: fullCaps() });
    const vm = fakeStatusViewModel();
    const output = renderer.render(vm);
    expect(output).toMatch(/\x1b\[/);
  });

  it("returns plain renderer for explicit plain mode", () => {
    const renderer = createSessionRenderer({ capabilities: fullCaps(), mode: "plain" });
    const vm = fakeStatusViewModel();
    const output = renderer.render(vm);
    expect(output).not.toMatch(/\x1b\[/);
  });
});

// ──────────────────────────────────────
// Backward-compatibility: string wrappers
// ──────────────────────────────────────

describe("Backward-compatible string wrappers", () => {
  it("renderSlashMenu still returns a string", () => {
    const output = renderSlashMenu(fakeRuntime);
    expect(typeof output).toBe("string");
  });

  it("renderToolsMenu still returns a string", () => {
    const output = renderToolsMenu(fakeRuntime);
    expect(typeof output).toBe("string");
  });

  it("renderSessionHelp still returns a string", () => {
    const output = renderSessionHelp();
    expect(typeof output).toBe("string");
  });
});

// ──────────────────────────────────────
// Phase 9: Startup snapshots
// ──────────────────────────────────────

describe("Session surfaces — startup", () => {
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const vm = buildStartupViewModel({
        agentName: "EstaCoda",
        taglines: ["Kemet Research", "السيادة التكنولوجية العربية"],
        model: { provider: "openrouter", id: "claude-sonnet-4" },
        readiness: "ready",
      });
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`startup-${ctx.name}`);
    });
  }
});

// ──────────────────────────────────────
// Phase 9.5: Startup dashboard snapshots
// ──────────────────────────────────────

describe("Session surfaces — startup dashboard", () => {
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const vm = buildStartupDashboardViewModel({
        agentName: "EstaCoda",
        taglines: ["Kemet Research", "السيادة التكنولوجية العربية"],
        version: "v0.0.5",
        sessionId: "4c6d7f55-7e8b-4f4f-8f39-111111111111",
        model: { provider: "openrouter", id: "deepseek-reasoner" },
        workspaceTrust: "trusted",
        workspaceVerification: "verified",
        workspaceDirectory: "/workspace",
        securityMode: "high",
        skillAutonomy: "autonomous",
        providerReadiness: "ready",
        versionStatus: "unknown",
        availableCommands: [],
        warnings: [],
      });
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`startup-dashboard-${ctx.name}`);
    });
  }
});

// ──────────────────────────────────────
// Phase 9: Picker snapshots
// ──────────────────────────────────────

describe("Session surfaces — picker", () => {
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const vm = buildPickerViewModel({
        title: "Select provider",
        options: [
          { id: "1", label: "OpenRouter", description: "Multi-provider gateway" },
          { id: "2", label: "Anthropic", description: "Direct Claude access" },
          { id: "3", label: "OpenAI", description: "GPT models" },
        ],
      });
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`picker-${ctx.name}`);
    });
  }
});

// ──────────────────────────────────────
// Phase 9: Input rail-frame snapshots
// ──────────────────────────────────────

describe("Session surfaces — input rail-frame", () => {
  for (const ctx of snapshotContexts()) {
    it(`renders horizontal rule in ${ctx.name}`, () => {
      const tokens = ctx.name === "plain" ? resolveTokens("plain", "light", "kemetBlue") : resolveTokens("standard", "dark", "kemetBlue");
      const useColor = ctx.name !== "plain" && ctx.name !== "no color";
      const useUnicode = ctx.name !== "plain" && ctx.name !== "no Unicode";
      const width = ctx.name === "narrow width" ? 40 : 80;
      const rule = renderHorizontalRule(tokens, useColor, useUnicode, width);
      expect(snapshotOutput(rule)).toMatchSnapshot(`rail-frame-${ctx.name}`);
    });

    it(`renders prompt prefix in ${ctx.name}`, () => {
      const tokens = ctx.name === "plain" ? resolveTokens("plain", "light", "kemetBlue") : resolveTokens("standard", "dark", "kemetBlue");
      const useColor = ctx.name !== "plain" && ctx.name !== "no color";
      const prefix = tokens.contract.branding.promptPrefix ?? `${tokens.contract.glyph.prompt} `;
      const colored = colorPromptPrefix(prefix, tokens, useColor);
      expect(snapshotOutput(colored)).toMatchSnapshot(`prompt-prefix-${ctx.name}`);
    });
  }

  it("renders bottom chrome rule with the secondary text token", () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const rule = renderBottomChromeRule(tokens, true, true, 10);
    expect(rule).toBe(`\x1B[38;2;176;176;176m${"─".repeat(10)}\x1B[0m`);
  });
});

// ────────────────────────────────────────
// Phase 9.5: Assistant response snapshots
// ────────────────────────────────────────

describe("Session surfaces — assistant response", () => {
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const vm = buildAssistantResponseViewModel({
        label: "\uD80C\uDDE0 EstaCoda",
        text: "Here is the analysis you requested.\n\nThe codebase is well-structured.",
        matchedSkills: ["code-review", "security-audit"],
        progress: ["intent routed", "security assessed", "tools executed"],
      });
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`assistant-response-${ctx.name}`);
    });
  }
});

// ──────────────────────────────────────
describe("Session surfaces — user prompt rail", () => {
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const vm = buildUserPromptRailViewModel({ text: "Tell me about quantum computing" });
      const output = ctx.renderer.render(vm);
      expect(snapshotOutput(output)).toMatchSnapshot(`user-prompt-rail-${ctx.name}`);
    });
  }

  it("does not render slash commands as user prompt rails", () => {
    const renderer = createSessionRenderer({ capabilities: fullCaps() });
    const slashMenu = buildSlashMenuViewModel(fakeRuntime, "");
    const userPromptRail = buildUserPromptRailViewModel({ text: "/help" });

    // Slash menu renders as a command result (tables), not as a prompt rail
    const slashOutput = renderer.render(slashMenu);
    expect(slashOutput).toContain("Commands");
    expect(slashOutput).toContain("/exit");

    // User prompt rail rendering is independent of slash-menu command routing.
    const railOutput = renderer.render(userPromptRail);
    expect(railOutput).toBe("↳ /help");
  });

  it("plain renderer produces no ANSI for user prompt rail", () => {
    const renderer = createSessionRenderer({ capabilities: plainCaps() });
    const vm = buildUserPromptRailViewModel({ text: "Hello" });
    const output = renderer.render(vm);
    expect(output).not.toMatch(/\x1b\[/);
    expect(output).toBe("> Hello");
  });
});
