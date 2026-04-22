import type {
  MemoryBudget,
  MemoryFileKind,
  MemoryUsage,
  RenderedMemorySnapshot
} from "../contracts/memory.js";
import type { MemorySnapshot } from "./memory-store.js";

const RENDER_ORDER: readonly MemoryFileKind[] = ["SOUL.md", "USER.md", "MEMORY.md", "AGENTS.md"];

export function renderMemorySnapshot(snapshot: MemorySnapshot): RenderedMemorySnapshot {
  const usage = renderUsage(snapshot);
  const sections: string[] = [
    "§ ESTACODA FROZEN MEMORY SNAPSHOT",
    "Memory is loaded once for this turn. Writes persist to disk but do not alter this snapshot until refresh.",
    ""
  ];

  for (const kind of RENDER_ORDER) {
    const content = snapshot.files.get(kind);

    if (content === undefined || content.trim().length === 0) {
      continue;
    }

    const usageLine = usage.find((entry) => entry.kind === kind);
    const budgetText =
      usageLine?.maxChars === undefined
        ? `${content.length} chars`
        : `${content.length}/${usageLine.maxChars} chars (${usageLine.percent}%)`;

    sections.push(`§ ${kind} ${budgetText}`, content.trim(), "");
  }

  sections.push("§ END ESTACODA FROZEN MEMORY SNAPSHOT");

  return {
    text: sections.join("\n"),
    usage
  };
}

function renderUsage(snapshot: MemorySnapshot): MemoryUsage[] {
  return [...snapshot.files.entries()].map(([kind, content]) => {
    const budget = findBudget(snapshot.budgets, kind);
    const chars = content.length;

    return {
      kind,
      chars,
      maxChars: budget?.maxChars,
      percent:
        budget === undefined ? undefined : Math.round((chars / budget.maxChars) * 100)
    };
  });
}

function findBudget(budgets: readonly MemoryBudget[], kind: MemoryFileKind): MemoryBudget | undefined {
  return budgets.find((budget) => budget.kind === kind);
}
