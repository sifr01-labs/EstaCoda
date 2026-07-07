import { coercePositiveInteger } from "./numeric-coercion.js";

export type MemoryRetrievalMode = "lexical";
export type MemoryIndexBackfillOnStartup = "off" | "bounded" | "full";
export type MemoryCurationMode = "auto" | "review" | "manual";
export type MemoryAutoApplyRisk = "low" | "medium" | "high";
export type MemoryAutoWriteVisibility = "activity" | "inline" | "off";

export type MemoryRetrievalConfig = {
  enabled: boolean;
  mode: MemoryRetrievalMode;
  maxResults: number;
  maxChars: number;
};

export type MemoryIndexConfig = {
  enabled: boolean;
  backfillOnStartup: MemoryIndexBackfillOnStartup;
  reindexOnStartup: boolean;
  vacuumIntervalDays: number;
};

export type MemoryCurationConfig = {
  mode: MemoryCurationMode;
  checkpointEveryTurns: number;
  auditOnCompact: boolean;
  auditOnHandoff: boolean;
  auditOnRuntimeDispose: boolean;
  runtimeDisposeMinNewMessages: number;
  runtimeDisposeMinIntervalMinutes: number;
  autoApplyMaxRisk: MemoryAutoApplyRisk;
  autoApplyMinConfidence: number;
  autoWriteVisibility: MemoryAutoWriteVisibility;
};

export type MemoryConfig = {
  retrieval: MemoryRetrievalConfig;
  index: MemoryIndexConfig;
  curation: MemoryCurationConfig;
};

export type MemoryConfigInput = {
  retrieval?: Partial<MemoryRetrievalConfig>;
  index?: Partial<MemoryIndexConfig>;
  curation?: Partial<MemoryCurationConfig>;
};

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  retrieval: {
    enabled: true,
    mode: "lexical",
    maxResults: 10,
    maxChars: 4_000
  },
  index: {
    enabled: true,
    backfillOnStartup: "bounded",
    reindexOnStartup: false,
    vacuumIntervalDays: 7
  },
  curation: {
    mode: "auto",
    checkpointEveryTurns: 25,
    auditOnCompact: true,
    auditOnHandoff: true,
    auditOnRuntimeDispose: true,
    runtimeDisposeMinNewMessages: 4,
    runtimeDisposeMinIntervalMinutes: 15,
    autoApplyMaxRisk: "low",
    autoApplyMinConfidence: 0.7,
    autoWriteVisibility: "activity"
  }
};

const MEMORY_RETRIEVAL_MAX_RESULTS_CAP = 50;
const MEMORY_RETRIEVAL_MAX_CHARS_CAP = 20_000;
const MEMORY_INDEX_VACUUM_INTERVAL_DAYS_CAP = 365;
const MEMORY_CURATION_CHECKPOINT_EVERY_TURNS_CAP = 500;
const MEMORY_CURATION_RUNTIME_DISPOSE_MIN_MESSAGES_CAP = 100;
const MEMORY_CURATION_RUNTIME_DISPOSE_MIN_INTERVAL_MINUTES_CAP = 24 * 60;
const MEMORY_INDEX_BACKFILL_VALUES: readonly MemoryIndexBackfillOnStartup[] = ["off", "bounded", "full"];
const MEMORY_CURATION_MODES: readonly MemoryCurationMode[] = ["auto", "review", "manual"];
const MEMORY_AUTO_APPLY_RISKS: readonly MemoryAutoApplyRisk[] = ["low", "medium", "high"];
const MEMORY_AUTO_WRITE_VISIBILITY_VALUES: readonly MemoryAutoWriteVisibility[] = ["activity", "inline", "off"];

export function normalizeMemoryConfig(value: MemoryConfigInput | undefined): MemoryConfig {
  return {
    retrieval: normalizeMemoryRetrievalConfig(value?.retrieval),
    index: normalizeMemoryIndexConfig(value?.index),
    curation: normalizeMemoryCurationConfig(value?.curation)
  };
}

function normalizeMemoryRetrievalConfig(value: Partial<MemoryRetrievalConfig> | undefined): MemoryRetrievalConfig {
  return {
    enabled: value?.enabled === undefined ? DEFAULT_MEMORY_CONFIG.retrieval.enabled : value.enabled === true,
    mode: normalizeMemoryRetrievalMode(value?.mode),
    maxResults: coercePositiveInteger(value?.maxResults, {
      default: DEFAULT_MEMORY_CONFIG.retrieval.maxResults,
      max: MEMORY_RETRIEVAL_MAX_RESULTS_CAP
    }),
    maxChars: coercePositiveInteger(value?.maxChars, {
      default: DEFAULT_MEMORY_CONFIG.retrieval.maxChars,
      max: MEMORY_RETRIEVAL_MAX_CHARS_CAP
    })
  };
}

function normalizeMemoryIndexConfig(value: Partial<MemoryIndexConfig> | undefined): MemoryIndexConfig {
  return {
    enabled: value?.enabled === undefined ? DEFAULT_MEMORY_CONFIG.index.enabled : value.enabled === true,
    backfillOnStartup: normalizeMemoryIndexBackfill(value?.backfillOnStartup),
    reindexOnStartup: value?.reindexOnStartup === true,
    vacuumIntervalDays: coercePositiveInteger(value?.vacuumIntervalDays, {
      default: DEFAULT_MEMORY_CONFIG.index.vacuumIntervalDays,
      max: MEMORY_INDEX_VACUUM_INTERVAL_DAYS_CAP
    })
  };
}

function normalizeMemoryCurationConfig(value: Partial<MemoryCurationConfig> | undefined): MemoryCurationConfig {
  return {
    mode: normalizeMemoryCurationMode(value?.mode),
    checkpointEveryTurns: coercePositiveInteger(value?.checkpointEveryTurns, {
      default: DEFAULT_MEMORY_CONFIG.curation.checkpointEveryTurns,
      max: MEMORY_CURATION_CHECKPOINT_EVERY_TURNS_CAP
    }),
    auditOnCompact: value?.auditOnCompact === undefined
      ? DEFAULT_MEMORY_CONFIG.curation.auditOnCompact
      : value.auditOnCompact === true,
    auditOnHandoff: value?.auditOnHandoff === undefined
      ? DEFAULT_MEMORY_CONFIG.curation.auditOnHandoff
      : value.auditOnHandoff === true,
    auditOnRuntimeDispose: value?.auditOnRuntimeDispose === undefined
      ? DEFAULT_MEMORY_CONFIG.curation.auditOnRuntimeDispose
      : value.auditOnRuntimeDispose === true,
    runtimeDisposeMinNewMessages: coercePositiveInteger(value?.runtimeDisposeMinNewMessages, {
      default: DEFAULT_MEMORY_CONFIG.curation.runtimeDisposeMinNewMessages,
      max: MEMORY_CURATION_RUNTIME_DISPOSE_MIN_MESSAGES_CAP
    }),
    runtimeDisposeMinIntervalMinutes: coercePositiveInteger(value?.runtimeDisposeMinIntervalMinutes, {
      default: DEFAULT_MEMORY_CONFIG.curation.runtimeDisposeMinIntervalMinutes,
      max: MEMORY_CURATION_RUNTIME_DISPOSE_MIN_INTERVAL_MINUTES_CAP
    }),
    autoApplyMaxRisk: normalizeMemoryAutoApplyRisk(value?.autoApplyMaxRisk),
    autoApplyMinConfidence: normalizeConfidence(value?.autoApplyMinConfidence),
    autoWriteVisibility: normalizeMemoryAutoWriteVisibility(value?.autoWriteVisibility)
  };
}

function normalizeMemoryRetrievalMode(value: unknown): MemoryRetrievalMode {
  if (value === undefined) {
    return DEFAULT_MEMORY_CONFIG.retrieval.mode;
  }
  if (value === "lexical") {
    return value;
  }
  throw new Error("memory.retrieval.mode must be lexical");
}

function normalizeMemoryIndexBackfill(value: unknown): MemoryIndexBackfillOnStartup {
  if (value === undefined) {
    return DEFAULT_MEMORY_CONFIG.index.backfillOnStartup;
  }
  if (typeof value === "string" && (MEMORY_INDEX_BACKFILL_VALUES as readonly string[]).includes(value)) {
    return value as MemoryIndexBackfillOnStartup;
  }
  throw new Error("memory.index.backfillOnStartup must be off, bounded, or full");
}

function normalizeMemoryCurationMode(value: unknown): MemoryCurationMode {
  if (value === undefined) {
    return DEFAULT_MEMORY_CONFIG.curation.mode;
  }
  if (typeof value === "string" && (MEMORY_CURATION_MODES as readonly string[]).includes(value)) {
    return value as MemoryCurationMode;
  }
  throw new Error("memory.curation.mode must be auto, review, or manual");
}

function normalizeMemoryAutoApplyRisk(value: unknown): MemoryAutoApplyRisk {
  if (value === undefined) {
    return DEFAULT_MEMORY_CONFIG.curation.autoApplyMaxRisk;
  }
  if (typeof value === "string" && (MEMORY_AUTO_APPLY_RISKS as readonly string[]).includes(value)) {
    return value as MemoryAutoApplyRisk;
  }
  throw new Error("memory.curation.autoApplyMaxRisk must be low, medium, or high");
}

function normalizeMemoryAutoWriteVisibility(value: unknown): MemoryAutoWriteVisibility {
  if (value === undefined) {
    return DEFAULT_MEMORY_CONFIG.curation.autoWriteVisibility;
  }
  if (typeof value === "string" && (MEMORY_AUTO_WRITE_VISIBILITY_VALUES as readonly string[]).includes(value)) {
    return value as MemoryAutoWriteVisibility;
  }
  throw new Error("memory.curation.autoWriteVisibility must be activity, inline, or off");
}

function normalizeConfidence(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_MEMORY_CONFIG.curation.autoApplyMinConfidence;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MEMORY_CONFIG.curation.autoApplyMinConfidence;
  }
  return Math.min(1, Math.max(0, value));
}
