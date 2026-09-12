import {createHash} from 'node:crypto';
import {join} from 'node:path';
import sharp from 'sharp';
import type {BrowserViewReference,BrowserViewSnapshot,WorkProjection} from '../contracts/desktop-control/index.js';
import {resolveProfileStateHome} from '../config/profile-home.js';
import {ArtifactStore,parseRegistration} from '../artifacts/artifact-store.js';
import {artifactDatabase,assertProfileContentRoot} from './artifacts.js';
import {listBrowserViews} from './browser-view.js';
/** Only existing, sanitized, identity-bound captures. Never initiates capture or follows URLs. */
export async function browserViewSnapshot(input:{homeDir:string;profileId:string},work:WorkProjection,reference:BrowserViewReference,signal:AbortSignal):Promise<BrowserViewSnapshot>{
 const current=async()=>{const list=await listBrowserViews(input,work,signal);const state=list.items.find(item=>item.reference.sessionId===reference.sessionId&&item.reference.browserId===reference.browserId&&item.reference.eventId===reference.eventId&&item.reference.target.targetId===reference.target.targetId&&item.reference.target.targetGeneration===reference.target.targetGeneration);if(!state)throw new Error('Browser observation changed. Refresh sessions.');return state;};
 const state=await current(),empty={state,image:null,reason:'No matching sanitized retained capture is available.'};
 if(state.state==='blocked')return{...empty,reason:'Browser observation is withheld by current policy or protected-input state.'};
 const db=await artifactDatabase(input);
 try{
  const original=db.db.query<{data:string}>("select json_extract(event_json,'$.result.metadata.snapshot') as data from session_events where session_id=? and rowid=?").get(reference.sessionId,reference.eventId);
  if(!original)return empty;const snapshot=JSON.parse(original.data);
  const rows=db.db.query<{created_at:string;data:string|null}>(`select created_at,case when length(event_json)<=16384 then json_extract(event_json,'$.result.metadata') else null end as data from session_events where session_id=? and rowid>? and json_valid(event_json) and json_extract(event_json,'$.kind')='tool-result' and json_extract(event_json,'$.tool')='browser.screenshot' and json_extract(event_json,'$.result.ok')=1 order by rowid desc limit 16`).all(reference.sessionId,reference.eventId);
  for(const row of rows){
   signal.throwIfAborted();if(!row.data)continue;const metadata=JSON.parse(row.data),observation=metadata.observation;
   if(observation?.sanitized!==true||observation.sessionId!==reference.browserId||!observation.identity||!snapshot.identity||observation.identity.documentEpoch!==snapshot.identity.documentEpoch||observation.identity.actionRevision!==snapshot.identity.actionRevision||observation.tabRef!==snapshot.tab?.ref||typeof metadata.artifactId!=='string')continue;
   const registered=db.db.query<{data:string|null}>(`select case when length(event_json)<=16384 then json_extract(event_json,'$.artifact') else null end as data from session_events where session_id=? and json_valid(event_json) and json_extract(event_json,'$.kind')='session-artifact-registered' and json_extract(event_json,'$.artifact.id')=? order by rowid desc limit 1`).get(reference.sessionId,metadata.artifactId);
   const registration=registered?.data?parseRegistration(JSON.parse(registered.data)):undefined;
   if(!registration||registration.source.kind!=='browser.screenshot'||registration.source.origin!=='browser:'+createHash('sha256').update(reference.browserId).digest('hex'))continue;
   try{
    const root=join(resolveProfileStateHome(input).profileRoot,'artifacts');await assertProfileContentRoot(input,root);
    const bytes=await new ArtifactStore({storageRoot:root}).verifiedImage(registration,{profileId:input.profileId,sessionId:reference.sessionId});
    let image:Buffer|undefined;
    for(const width of [960,640,320]){signal.throwIfAborted();image=await sharp(bytes,{limitInputPixels:16_000_000}).rotate().resize({width,height:640,fit:'inside',withoutEnlargement:true}).jpeg({quality:50}).toBuffer();if(image.length<=45000)break;}
    const checked=await current();signal.throwIfAborted();if(checked.state==='blocked'||!image||image.length>45000)return{...empty,state:checked};
    return{state:checked,image:{mimeType:'image/jpeg',base64:image.toString('base64'),observedAt:row.created_at},reason:null};
   }catch{signal.throwIfAborted();return{...empty,state:await current()};}
  }
  return empty;
 }finally{db.close();}
}
