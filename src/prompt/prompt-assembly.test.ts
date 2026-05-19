import { describe, expect, it } from "vitest";
import type { IntentRoute } from "../contracts/intent.js";
import type { ModelProfile, ProviderMessage } from "../contracts/provider.js";
import { assembleProviderPrompt } from "./prompt-assembly.js";

const model: ModelProfile = {
  id: "test-model",
  provider: "test-provider",
  contextWindowTokens: 128_000,
  supportsTools: false,
  supportsVision: false,
  supportsStructuredOutput: false
};

const generalIntent: IntentRoute = {
  nativeIntent: "general",
  labels: ["general"],
  confidence: 1,
  suggestedSkills: [],
  suggestedToolsets: [],
  confirmationRequired: false,
  evidence: [],
  rationale: "No specialized route matched."
};

function renderMessages(messages: ProviderMessage[]): string {
  return messages.map((message) => {
    if (typeof message.content === "string") {
      return message.content;
    }

    if (Array.isArray(message.content)) {
      return message.content.map((part) =>
        part.type === "text" ? part.text : ""
      ).join("\n");
    }

    return String(message.content);
  }).join("\n\n");
}

describe("assembleProviderPrompt", () => {
  it("uses direct-response guidance instead of exposing no-skill fallback copy", () => {
    const prompt = assembleProviderPrompt({
      model,
      userText: "What is this project?",
      routedText: "What is this project?",
      selectedSkill: undefined,
      selectedSkillInstructions: undefined,
      selectedSkillResources: undefined,
      selectedSkillSetup: undefined,
      intent: generalIntent,
      securityDecision: "allow",
      toolExecutions: [],
      context: undefined,
      projectContext: undefined,
      memoryPromptContext: undefined,
      providerTools: [],
      fallbackText: "I did not find a matching skill yet. I would answer directly and record this interaction for future skill discovery."
    });

    const rendered = renderMessages(prompt.messages);

    expect(rendered).toContain("Response guidance:");
    expect(rendered).toContain("Answer the user directly using the available context.");
    expect(rendered).not.toContain("Deterministic fallback response if model cannot improve it");
    expect(rendered).not.toMatch(/matching skill/i);
    expect(rendered).not.toMatch(/future skill discovery/i);
    expect(rendered).not.toMatch(/I would answer directly/i);
  });

  it("renders canonical memory blocks exactly once before project context and session history", () => {
    const prompt = assembleProviderPrompt({
      model,
      userText: "Use memory.",
      routedText: "Use memory.",
      sessionHistory: [
        {
          role: "user",
          content: "Historical turn marker"
        }
      ],
      selectedSkill: undefined,
      selectedSkillInstructions: undefined,
      selectedSkillResources: undefined,
      selectedSkillSetup: undefined,
      intent: generalIntent,
      securityDecision: "allow",
      toolExecutions: [],
      context: undefined,
      projectContext: {
        workspaceRoot: "/workspace",
        files: [
          {
            source: "AGENTS.md",
            kind: "project-file",
            title: "Shared agent context",
            content: "Project context unique rule",
            status: "loaded",
            bytes: "Project context unique rule".length,
            warnings: []
          }
        ],
        warnings: []
      },
      memoryPromptContext: {
        frozenCompactMemory: [
          promptMemoryBlock("memory:user", "learned-user", "user-global", "USER.md", "- User unique preference"),
          promptMemoryBlock("memory:project", "learned-project", "project", "MEMORY.md", "- Project unique fact")
        ],
        safetyMemory: [
          promptMemoryBlock("memory:soul", "identity", "user-global", "SOUL.md", "Identity unique directive")
        ],
        diagnostics: {
          includedBlocks: [],
          suppressedEntries: 0,
          duplicateEntriesRemoved: 0,
          recallTriggered: false,
          budgetPressure: [],
          compactionPressure: [],
          warnings: []
        }
      },
      providerTools: [],
      fallbackText: "fallback"
    });

    const rendered = renderMessages(prompt.messages);

    expect(countOccurrences(rendered, "USER.md")).toBe(1);
    expect(countOccurrences(rendered, "MEMORY.md")).toBe(1);
    expect(countOccurrences(rendered, "SOUL.md")).toBe(1);
    expect(rendered).toContain("Safety and identity memory:");
    expect(rendered).toContain("Canonical memory prompt context:");
    expect(rendered).not.toContain("Frozen memory snapshot:");
    expect(rendered).not.toContain("Memory provider context:");

    expect(rendered.indexOf("Safety and identity memory:")).toBeLessThan(
      rendered.indexOf("Canonical memory prompt context:")
    );
    expect(rendered.indexOf("Canonical memory prompt context:")).toBeLessThan(
      rendered.indexOf("Project context:")
    );
    expect(rendered.indexOf("Project context:")).toBeLessThan(
      rendered.indexOf("Session history:")
    );
  });
});

function promptMemoryBlock(
  id: string,
  kind: "learned-user" | "learned-project" | "identity",
  scope: "user-global" | "project",
  source: string,
  content: string
) {
  return {
    id,
    kind,
    scope,
    source,
    content,
    chars: content.length,
    trusted: true
  };
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}
