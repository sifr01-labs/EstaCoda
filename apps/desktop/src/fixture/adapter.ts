import{DEFAULT_APPEARANCE}from'../shared/appearance.js';
import type{DesktopSnapshot}from'../shared/desktop-api.js';
import type{DesktopAdapter,FixtureControls}from'../renderer/adapter.js';
export function fixtureAdapter():DesktopAdapter {
 const listeners=new Set<(snapshot:DesktopSnapshot)=>void>();
 let preferences={...DEFAULT_APPEARANCE};
 const fixture:FixtureControls={phase:'waiting',work:{
  retry:{id:'retry',displayId:'EC-024',title:'Make billing retries resilient',prompt:'Add bounded retries to the billing client. Keep the public API unchanged and verify the retry behavior.',summary:'I added exponential backoff with a three-attempt limit. The public API is unchanged. The focused test suite is ready to run.'},
  webhook:{id:'webhook',displayId:'EC-023',title:'Review webhook security',prompt:'Review signature validation and identify any unsafe failure paths. Do not change the code.',summary:'Signature validation fails closed. I found one follow-up: the timestamp check should reject replayed requests outside the configured window.'},
  logs:{id:'logs',displayId:'EC-022',title:'Summarize deployment logs',prompt:'Review the deployment logs and identify the cause of the latest rollback.',summary:'I reviewed the available logs. The rollout stopped after a failed health check, but the application error logs were unavailable. The root cause remains unconfirmed.'},
 },act:()=>{},subscribe:()=>()=>{}};
 const snapshot=():DesktopSnapshot=>({status:'ready',profile:{id:'personal',label:'Personal',configuration:'ready'},runtime:'ready',work:{items:Object.values(fixture.work).map(work=>({id:work.id,canonicalId:work.id,profileId:'personal',kind:'session',title:work.title,status:work.id==='retry'?({waiting:'needs_attention',running:'running',done:'completed',denied:'partial',stopping:'running',stopped:'cancelled'} as const)[fixture.phase]:work.id==='webhook'?'completed':'partial',updatedAt:1789036920000,target:{targetId:'payments-api',targetGeneration:1,label:'payments-api',isolation:'host'}})),nextCursor:null},inbox:{items:fixture.phase==='waiting'?[{id:'approval',profileId:'personal',workId:'retry',kind:'approval',title:'Run the focused test suite',summary:'pnpm test -- retry',createdAt:1789036920000,approval:{id:'approval',sessionId:'retry',target:{targetId:'payments-api',targetGeneration:1},actionSummary:'Run the focused test suite',scope:'once',decisions:['approved','denied']}}]:[],nextCursor:null}});
 const api:DesktopAdapter['api']={snapshot:async()=>snapshot(),onSnapshot:listener=>{listeners.add(listener);listener(snapshot());return()=>{listeners.delete(listener);};},activity:async()=>({items:[],nextCursor:null}),profiles:async()=>[{id:'personal',label:'Personal'}],switchProfile:async()=>{},appearance:async()=>({...preferences}),setAppearance:async value=>{preferences={...value};},minimize:async()=>{},toggleMaximize:async()=>{},close:async()=>{}};
 return{kind:'fixture',api,fixture,appearance:{read:api.appearance,write:api.setAppearance}};
}
