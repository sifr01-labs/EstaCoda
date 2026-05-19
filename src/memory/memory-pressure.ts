import type {
  MemoryBudget,
  MemoryBudgetPressure,
  MemoryBudgetPressureState,
  MemoryFileKind
} from "../contracts/memory.js";
import type { MemorySnapshot } from "./memory-store.js";

export const MEMORY_PRESSURE_WARNING_RATIO = 0.8;
export const MEMORY_PRESSURE_CRITICAL_RATIO = 0.95;

export function calculateMemoryBudgetPressure(input: {
  kind: MemoryFileKind;
  chars: number;
  maxChars: number;
}): MemoryBudgetPressure {
  const ratio = input.maxChars <= 0
    ? input.chars > 0 ? Number.POSITIVE_INFINITY : 0
    : input.chars / input.maxChars;
  const state = memoryBudgetPressureState(ratio);
  const remainingChars = input.maxChars - input.chars;
  const overflowChars = input.chars - input.maxChars;

  return {
    kind: input.kind,
    source: input.kind,
    chars: input.chars,
    maxChars: input.maxChars,
    ratio,
    percent: Math.round(ratio * 100),
    state,
    remainingChars: remainingChars > 0 ? remainingChars : 0,
    overflowChars: overflowChars > 0 ? overflowChars : 0
  };
}

export function calculateSnapshotBudgetPressure(snapshot: MemorySnapshot): MemoryBudgetPressure[] {
  return snapshot.budgets
    .filter((budget) => budget.kind === "USER.md" || budget.kind === "MEMORY.md")
    .map((budget) => calculateMemoryBudgetPressure({
      kind: budget.kind,
      chars: snapshot.files.get(budget.kind)?.length ?? 0,
      maxChars: budget.maxChars
    }));
}

export function memoryBudgetPressureState(ratio: number): MemoryBudgetPressureState {
  if (!Number.isFinite(ratio)) {
    return ratio > 0 ? "overflow" : "ok";
  }

  if (ratio > 1) {
    return "overflow";
  }
  if (ratio >= MEMORY_PRESSURE_CRITICAL_RATIO) {
    return "critical";
  }
  if (ratio >= MEMORY_PRESSURE_WARNING_RATIO) {
    return "warning";
  }
  return "ok";
}

export function findBudget(budgets: readonly MemoryBudget[], kind: MemoryFileKind): MemoryBudget | undefined {
  return budgets.find((budget) => budget.kind === kind);
}
