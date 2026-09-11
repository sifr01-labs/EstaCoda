export type CandidateRoute = {
  providerId: string; modelId: string; endpoint: string;
  authMethod: 'api_key' | 'oauth' | 'none';
  apiMode: 'openai_chat_completions' | 'openai_responses' | 'custom_openai_compatible';
  allowPrivateEndpoint: boolean;
};
export type VerifyCandidateParams = {
  windowId: string; generation: number; candidateId?: string;
  route: CandidateRoute; spendApproved: true;
};
export type CandidateVerification = {
  state: 'passed' | 'failed' | 'cancelled';
  reason: 'none' | 'unreachable' | 'invalid_credential' | 'model_unavailable' | 'unsupported' | 'incomplete' | 'cancelled';
  streaming: boolean; tools: boolean; latencyMs: number;
  inputTokens: number | null; outputTokens: number | null;
  estimatedCost: number | null;
};
