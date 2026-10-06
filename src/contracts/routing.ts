import type { IntentLabel, IntentTaskClass, NativeIntent } from './intent.js';

export type RoutingMode = 'standard' | 'jev-assisted';
export const ROUTING_DECISION_VERSION = 1 as const;
/** Specialized decision models are not chat/completions providers. */
export const JEV_MODELS = [{ id: 'jev-1.13.0', label: 'Jev 1.13' }] as const;
export const DEFAULT_JEV_MODEL = JEV_MODELS[0].id;
export const TYPESAFE_API_KEY_ENV = 'TYPESAFE_API_KEY';
export type RoutingConfig = {
  mode?: RoutingMode;
  jev?: { provider?: 'typesafe'; id?: string; apiKeyEnv?: string; timeoutMs?: number };
};
export type ResolvedRoutingConfig = {
  mode: RoutingMode;
  jev: { provider: 'typesafe'; id: string; apiKeyEnv: string; timeoutMs: number };
};
/** Independent applicability judgments; probabilities do not sum across items. */
export type RoutingSelection = { id: string; probability?: number; selected: boolean };
/** Advisory selection only. Never carries authorization or completion evidence. */
export type RoutingDecision = {
  schemaVersion: typeof ROUTING_DECISION_VERSION;
  configuredMode: RoutingMode;
  actualEngine: 'standard' | 'jev';
  model?: string;
  catalogRevision: string;
  configurationRevision: string;
  nativeIntent: NativeIntent;
  taskClass: IntentTaskClass;
  intents: Array<RoutingSelection & { id: IntentLabel }>;
  skills: RoutingSelection[];
  primarySkillId?: string;
  capabilities: RoutingSelection[];
  fallbackReason?: 'engine-unavailable' | 'credentials-unavailable' | 'timeout' | 'service-error' | 'invalid-response' | 'uncertain';
};
