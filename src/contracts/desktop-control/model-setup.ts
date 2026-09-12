export type CandidateRoute = {
  providerId: string; modelId: string; endpoint: string;
  authMethod: 'api_key' | 'oauth' | 'none';
  apiMode: 'openai_chat_completions' | 'openai_responses' | 'custom_openai_compatible';
  allowPrivateEndpoint: boolean;
  enableNetwork?:boolean;contextWindowTokens?:number;maxTokens?:number;
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
export type ModelRouteDraft = {draftId:string;route?:CandidateRoute;expiresInMs:number;credentialState:'staged'|'existing'|'not_required';role:'primary'|'fallback'|'fallback_order'|'auxiliary'|'auxiliary_mode';slot?:AuxiliarySlot};
export type ModelDraftBinding = {draftId:string;windowId:string;generation:number};
export type ModelApplyReceipt = {operationId:string;state:'applied'|'uncertain'|'unknown';verification:'configured'|'repair_required'|'not_tested'};

export function candidateRouteBinding(route:CandidateRoute):string {
  return JSON.stringify([route.providerId,route.modelId,route.endpoint,route.authMethod,route.apiMode,route.allowPrivateEndpoint,route.enableNetwork??true,route.contextWindowTokens??null,route.maxTokens??null]);
}

export type FallbackList={revision:string;items:{index:number;providerId:string;modelId:string}[]};
export type FallbackOrderParams={windowId:string;generation:number;revision:string;order:number[]};

export const AUXILIARY_SLOTS=['assessor','compression','session_search','memory_compaction','profile_context'] as const;
export type AuxiliarySlot=typeof AUXILIARY_SLOTS[number];
export type AuxiliaryList={items:{slot:AuxiliarySlot;mode:'main'|'auto'|'dedicated'|'disabled';providerId:string|null;modelId:string|null;fallbackToMain:boolean;credentialState:'missing'|'present'|'expired'|'not_required';runnable:boolean}[]};
export type AuxiliaryModeParams={windowId:string;generation:number;slot:AuxiliarySlot;mode:'main'|'auto'|'disabled';fallbackToMain:boolean};

export type OAuthBinding={authorizationId:string;windowId:string;generation:number};
export type OAuthStatus={authorizationId:string;state:'starting'|'pending'|'authorized'|'failed'|'cancelled'|'expired';verificationUrl:string|null;userCode:string|null;candidateId:string|null};

export type RouteRole={role:'primary'|'fallback'|'auxiliary';slot?:AuxiliarySlot;fallbackToMain?:boolean};
export type ConfiguredRouteReview=RouteRole & {windowId:string;generation:number;providerId:string;modelId:string};
