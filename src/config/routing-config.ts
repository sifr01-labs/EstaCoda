import { DEFAULT_JEV_MODEL, TYPESAFE_API_KEY_ENV, type ResolvedRoutingConfig, type RoutingConfig } from '../contracts/routing.js';

/** Strict normalization shared by runtime loading and reviewed model setup. */
export function normalizeRoutingConfig(value: RoutingConfig | undefined): ResolvedRoutingConfig {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error('routing must be an object');
  const mode = value?.mode ?? 'standard';
  if (mode !== 'standard' && mode !== 'jev-assisted') throw new Error('routing.mode must be standard or jev-assisted');
  const jev = value?.jev;
  if (jev !== undefined && (!jev || typeof jev !== 'object' || Array.isArray(jev))) throw new Error('routing.jev must be an object');
  if (jev?.provider !== undefined && jev.provider !== 'typesafe') throw new Error('routing.jev.provider must be typesafe');
  const id = jev?.id ?? DEFAULT_JEV_MODEL;
  if (typeof id !== 'string' || !/^jev-[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(id)) throw new Error('routing.jev.id must be a Jev model identifier');
  const apiKeyEnv = jev?.apiKeyEnv ?? TYPESAFE_API_KEY_ENV;
  if (typeof apiKeyEnv !== 'string' || !/^[A-Z][A-Z0-9_]{1,127}$/.test(apiKeyEnv)) throw new Error('routing.jev.apiKeyEnv must be an environment variable reference');
  const timeoutMs = jev?.timeoutMs ?? 5_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new Error('routing.jev.timeoutMs must be an integer from 100 to 60000');
  return { mode, jev: { provider: 'typesafe', id, apiKeyEnv, timeoutMs } };
}
