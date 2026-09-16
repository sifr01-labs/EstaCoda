import {AUXILIARY_SLOTS,type CandidateRoute,type ModelProjection,type ModelRouteDraft,type RouteRole} from '@estacoda/control-protocol';
import type {DesktopModelsApi} from '../shared/desktop-api.js';
/** In-memory fixture only. No credentials, network, or persistent configuration. */
export function fixtureModels():DesktopModelsApi{
 const models:ModelProjection[]=[{id:'kimi-k3',label:'Kimi K3',providerId:'kimi',role:'primary',health:'configured',runnable:true,credentialState:'present',catalog:{source:'configured',configured:true,catalogOnly:false,lifecycle:'available',contextTokens:1000000,outputTokens:128000,tools:true,vision:true,price:{inputPerMillion:3,outputPerMillion:15}}}];
 let route:CandidateRoute={providerId:'kimi',modelId:'kimi-k3',endpoint:'https://api.moonshot.ai/v1',authMethod:'api_key',apiMode:'openai_chat_completions',allowPrivateEndpoint:false};
 let selectedRole:RouteRole={role:'provider'};
 const fallbacks:{index:number;providerId:string;modelId:string}[]=[];
 const auxiliary=AUXILIARY_SLOTS.map(slot=>({slot,mode:'main' as 'main'|'auto'|'dedicated'|'disabled',providerId:'kimi',modelId:'kimi-k3',credentialState:'present' as const,runnable:true,fallbackToMain:true}));
 const draft=():ModelRouteDraft=>({draftId:'sample',route,role:selectedRole.role,...(selectedRole.slot?{slot:selectedRole.slot}:{}),expiresInMs:300000,credentialState:'staged'});
 let pending=()=>{};
 const receipt=()=>({operationId:'sample',state:'applied' as const,verification:'configured' as const});
 const verify=async()=>({state:'passed' as const,reason:'none' as const,streaming:true,tools:true,latencyMs:40,inputTokens:1,outputTokens:1,estimatedCost:0});
 return{
  models:async()=>({items:[...models],nextCursor:null}),providers:async()=>({items:[{id:'kimi',label:'Kimi',state:'ready',health:'configured',authMethods:['api_key'],metadata:{configurable:true,runnable:true,catalogOnly:false,apiMode:'openai_chat_completions',defaultEndpoint:'https://api.moonshot.ai/v1'}},{id:'local',label:'Local',state:'unconfigured',health:'not_configured',authMethods:['none'],metadata:{configurable:true,runnable:true,catalogOnly:false,apiMode:'custom_openai_compatible',defaultEndpoint:'http://localhost:11434/v1'}}],nextCursor:null}),
  routes:async()=>({fallbacks:{revision:'sample',items:[...fallbacks]},auxiliary:{items:[...auxiliary]}}),refreshCatalog:async()=>({refreshed:true}),
  begin:async value=>{route=value;return{setupId:'sample'};},stage:async()=>({staged:true}),cancel:async()=>{pending=()=>{};return{cancelled:true};},review:async(_id,role)=>{selectedRole=role??{role:'primary'};return draft();},verify,verifyReviewed:verify,
  reviewConfigured:async selection=>{selectedRole=selection;route={...route,providerId:selection.providerId,modelId:selection.modelId};return{setupId:'sample',draft:draft()};},
  reviewOrder:async({order})=>{const next=order.map(i=>fallbacks[i]!);pending=()=>{fallbacks.splice(0,fallbacks.length,...next);};return{setupId:'sample',draft:{draftId:'sample',role:'fallback_order',expiresInMs:300000,credentialState:'not_required'}};},
  reviewMode:async({slot,mode})=>{const a=auxiliary.find(a=>a.slot===slot)!;pending=()=>{a.mode=mode;};return{setupId:'sample',draft:{draftId:'sample',slot,role:'auxiliary_mode',expiresInMs:300000,credentialState:'not_required'}};},
  apply:async()=>{pending();pending=()=>{};return receipt();},inspect:async()=>receipt(),
  oauthStart:async()=>{throw Error('OAuth is not simulated');},oauthStatus:async()=>{throw Error('OAuth is not simulated');},oauthOpen:async()=>{},workOverride:async()=>({selection:null,effective:'next_turn'}),setOverride:async()=>{throw Error('No work in this fixture');},inspectOverride:async()=>null,
 };
}
