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
export type ModelRouteDraft = {draftId:string;route?:CandidateRoute;expiresInMs:number;credentialState:'staged'|'not_required';role:'primary'|'fallback'|'fallback_order'};
export type ModelDraftBinding = {draftId:string;windowId:string;generation:number};
export type ModelApplyReceipt = {operationId:string;state:'applied'|'uncertain'|'unknown';verification:'configured'|'repair_required'|'not_tested'};

export function candidateRouteBinding(route:CandidateRoute):string {
  return JSON.stringify([route.providerId,route.modelId,route.endpoint,route.authMethod,route.apiMode,route.allowPrivateEndpoint]);
}

export type FallbackList={revision:string;items:{index:number;providerId:string;modelId:string}[]};
export type FallbackOrderParams={windowId:string;generation:number;revision:string;order:number[]};
