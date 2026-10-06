import type { ProviderUsage } from '../../contracts/provider.js';
import type { JevAnswer, JevThresholds } from './types.js';
import { probability, type WireQuestion } from './payload.js';

export function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function readJevUsage(value: unknown): ProviderUsage | undefined {
  if (!object(value) || !Number.isSafeInteger(value.input_tokens) || !Number.isSafeInteger(value.output_tokens)) return undefined;
  const inputTokens = value.input_tokens as number, outputTokens = value.output_tokens as number;
  if (inputTokens < 0 || outputTokens < 0 || !Number.isSafeInteger(inputTokens + outputTokens)) return undefined;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}
export function resolvedJevModel(value: unknown, requested: string): string | undefined {
  if (typeof value !== 'string' || !/^jev-\d+\.\d+\.\d+$/.test(value)) return undefined;
  return value === requested || ['jev-latest', 'jev-preview'].includes(requested) ? value : undefined;
}
function distribution(value: unknown, expected: readonly string[]): Record<string, number> | undefined {
  if (!object(value) || Object.keys(value).length !== expected.length || expected.some(id => !Object.hasOwn(value, id) || !probability(value[id]))) return undefined;
  const probabilities = Object.fromEntries(expected.map(id => [id, value[id] as number]));
  return Math.abs(Object.values(probabilities).reduce((a, b) => a + b, 0) - 1) <= 0.0001 ? probabilities : undefined;
}
export function readJevAnswers(value: unknown, questions: Record<string, WireQuestion>, policy: JevThresholds): JevAnswer[] | undefined {
  if (!object(value) || Object.keys(value).some(id => !Object.hasOwn(questions, id))) return undefined;
  return Object.entries(questions).map(([id, q]): JevAnswer => {
    if (!Object.hasOwn(value, id)) return { id, status: 'missing' };
    const answer = value[id];
    const invalid: JevAnswer = { id, status: 'invalid' };
    if (!object(answer) || answer.type !== q.type) return invalid;
    if (q.type === 'noul') {
      if (!probability(answer.noul)) return invalid;
      return { id, type: q.type, probability: answer.noul, status: answer.noul >= policy.acceptAt ? 'accepted' : answer.noul <= policy.rejectAt ? 'rejected' : 'uncertain' };
    }
    if (!probability(answer.confidence)) return invalid;
    const keys = q.type === 'choice' ? Object.keys(q.criteria!) : (q.criteria as string[]).map((_, i) => String(i));
    const probabilities = distribution(answer.probabilities, keys);
    if (!probabilities) return invalid;
    const status = answer.confidence >= policy.minConfidence ? 'accepted' : 'uncertain';
    if (q.type === 'choice') {
      if (typeof answer.choice !== 'string' || !Object.hasOwn(probabilities, answer.choice) || probabilities[answer.choice] + 0.000001 < Math.max(...Object.values(probabilities))) return invalid;
      return { id, type: q.type, status, choice: answer.choice, probabilities, confidence: answer.confidence };
    }
    const levels = q.criteria as string[], legend = answer.legend;
    if (!object(legend) || Object.keys(legend).length !== levels.length || levels.some((level, i) => legend[String(i)] !== level)) return invalid;
    const weighted = keys.reduce((sum, key) => sum + Number(key) * probabilities[key], 0);
    if (typeof answer.score !== 'number' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > levels.length - 1 || Math.abs(answer.score - weighted) > 0.0001) return invalid;
    return { id, type: q.type, status, score: answer.score, probabilities, confidence: answer.confidence };
  });
}
