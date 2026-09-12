import {oauthCandidate} from './oauth-candidate.js';
import {candidateRouteBinding, ControlProtocolError, type VerifyCandidateParams, type CandidateVerification} from '../contracts/desktop-control/index.js';
import {getProviderMetadata} from '../providers/provider-metadata.js';
import {createOpenAICompatibleProvider, type FetchLike} from '../providers/openai-compatible-provider.js';
import {createOpenAIResponsesProvider} from '../providers/openai-responses-provider.js';
import {inferModelProfile} from '../providers/model-catalog.js';
import {isAlwaysBlockedUrl, scanUrlForSecrets, normalizeHostname, normalizeIpForChecks, isPrivateOrInternalIp} from '../browser/url-safety.js';
import {CredentialCandidates, type CandidateScope} from './credential-candidates.js';
import {verificationFetch} from './verification-fetch.js';

export function validateCandidateRequest(params: VerifyCandidateParams): void {
    const {route} = params;
    const metadata = getProviderMetadata(route.providerId);
    let endpoint: URL;
    try {endpoint = new URL(route.endpoint);} catch {throw new ControlProtocolError('-32602');}
    const host=normalizeHostname(endpoint.hostname), ip=normalizeIpForChecks(host);
    const localHttp=route.allowPrivateEndpoint && (host==='localhost' || (ip!==undefined && isPrivateOrInternalIp(ip)));
    if (!params.spendApproved || isAlwaysBlockedUrl(route.endpoint) || scanUrlForSecrets(route.endpoint) ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && localHttp)) ||
      !metadata.configurable || !metadata.runnable ||
      (!metadata.allowsCustomBaseUrl && route.endpoint !== metadata.defaultBaseUrl) ||
      (metadata.catalogKnown && route.apiMode !== metadata.apiMode) ||
      (route.authMethod === 'api_key' && !metadata.authMethods.includes('api_key')) ||
      (route.authMethod === 'oauth' && !metadata.authMethods.some(method => method.startsWith('oauth'))) ||
      (route.authMethod === 'none' && !metadata.authMethods.includes('none')) ||
      (route.authMethod !== 'none' && !params.candidateId) || (route.authMethod === 'none' && params.candidateId)) throw new ControlProtocolError('-32602');
}

export class CandidateVerifier {
  readonly #busy = new Set<string>();
  readonly #abort = new AbortController();
  constructor(readonly candidates: CredentialCandidates, readonly fetchFactory = verificationFetch) {}
  dispose() {this.#abort.abort();}
  async verify(params: VerifyCandidateParams, signal: AbortSignal): Promise<CandidateVerification> {
    validateCandidateRequest(params);
    const {route}=params;
    const binding = params.candidateId ?? `${params.windowId}:${params.generation}`;
    if (this.#busy.has(binding) || this.#busy.size >= 8) throw new ControlProtocolError('-32009');
    const scope: CandidateScope = {windowId:params.windowId,generation:params.generation,purpose:'provider',providerId:route.providerId,
      authMethod:route.authMethod === 'oauth' ? 'oauth' : 'api_key',endpoint:route.endpoint};
    if(params.candidateId)this.candidates.bindRoute(params.candidateId,scope,candidateRouteBinding(route));
    let value = params.candidateId ? this.candidates.read(params.candidateId, scope) : undefined;
    if(route.authMethod==='oauth' && value){
      try{value=oauthCandidate(value,route.providerId).accessToken;}
      catch{if(params.candidateId)this.candidates.discard(params.candidateId,scope);throw new ControlProtocolError('-32602');}
    }
    const combined = AbortSignal.any([signal, this.#abort.signal, AbortSignal.timeout(12_000),
      ...(params.candidateId ? [this.candidates.signal(params.candidateId, scope)] : [])]);
    this.#busy.add(binding);
    const started = performance.now();
    const result: CandidateVerification = {state:'failed',reason:'unreachable',streaming:false,tools:false,latencyMs:0,inputTokens:null,outputTokens:null,estimatedCost:null};
    try {
      combined.throwIfAborted();
      const options = {id:route.providerId,endpoint:{baseUrl:route.endpoint,apiKey:{kind:'none' as const}},models:[route.modelId],
        enableNetwork:true,fetch:this.fetchFactory(route.endpoint, route.allowPrivateEndpoint, combined) as FetchLike};
      const provider = route.apiMode === 'openai_responses' ? createOpenAIResponsesProvider(options) : createOpenAICompatibleProvider(options);
      if (!provider.stream) {result.reason='unsupported';return result;}
      let done = false;
      for await (const event of provider.stream({model:route.modelId,stream:true,maxTokens:64,
        messages:[{role:'user',content:'Call the verification_ping tool with an empty object. This is a connectivity test.'}],
        tools:[{type:'function',function:{name:'verification_ping',description:'Connectivity test; never executed.',parameters:{type:'object',properties:{},additionalProperties:false}}}]},
        {credential:{id:'candidate',value},signal:combined,timeoutMs:12_000,staleTimeoutMs:12_000})) {
        combined.throwIfAborted();
        if (event.kind==='token' || event.kind==='tool-call') result.streaming=true;
        if (event.kind==='tool-call' && event.name==='verification_ping') result.tools=true;
        if (event.kind==='done' || event.kind==='error') {
          done=true; const response=event.response;
          result.reason = response.ok ? (['stop','tool_calls'].includes(response.finishReason ?? '') ? 'none':'incomplete') :
            response.errorClass==='auth'?'invalid_credential':response.errorClass==='model-unavailable'?'model_unavailable':response.errorClass==='unsupported'?'unsupported':'unreachable';
          const finite = (n: number | undefined) => Number.isSafeInteger(n) && n!>=0 ? n! : null;
          result.inputTokens=finite(response.usage?.inputTokens);result.outputTokens=finite(response.usage?.outputTokens);
          const cost=inferModelProfile({provider:route.providerId,model:route.modelId}).cost;
          if (result.inputTokens!==null && result.outputTokens!==null && cost?.inputPerMillionTokens!==undefined && cost.outputPerMillionTokens!==undefined)
            result.estimatedCost=(result.inputTokens*cost.inputPerMillionTokens+result.outputTokens*cost.outputPerMillionTokens)/1_000_000;
        }
      }
      if (done && result.reason==='none' && result.streaming && result.tools) result.state='passed';
      else if (result.reason==='none') result.reason='incomplete';
    } catch {
      if (signal.aborted || this.#abort.signal.aborted || (combined.aborted && combined.reason?.name !== 'TimeoutError')) {result.state='cancelled';result.reason='cancelled';}
    } finally {
      result.latencyMs=Math.max(0,Math.round(performance.now()-started));this.#busy.delete(binding);
      if (params.candidateId && result.state!=='passed') {try {this.candidates.discard(params.candidateId,scope);} catch { /* Already closed/expired. */ }}
    }
    return result;
  }
}
