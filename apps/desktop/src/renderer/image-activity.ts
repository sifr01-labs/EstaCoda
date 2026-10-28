import type {ActivityProjection,ArtifactReference} from '@estacoda/control-protocol';
import {toolActions,type ActivityRun} from './conversation-activity.js';

export type ImageSubmission={id:string;text:string;workId:string;profileId:string;targetId:string;targetGeneration:number};
export type ImageOutput=Extract<ActivityProjection,{kind:'artifact'}>;
const IMAGE_TYPES=new Set(['image/png','image/jpeg','image/webp','image/gif']);
export const isImageOutput=(item:ActivityProjection):item is ImageOutput=>item.kind==='artifact'&&IMAGE_TYPES.has(item.mimeType);
export const imageKey=(item:ImageOutput)=>JSON.stringify([item.profileId,item.workId,item.reference.source,item.reference.ownerId,item.reference.artifactId]);
export const sameReference=(a:ArtifactReference,b:ArtifactReference)=>a.source===b.source&&a.ownerId===b.ownerId&&a.artifactId===b.artifactId;

/** Explicit source reference travels through the ordinary, governed chat submission. */
export function imageEditPrompt(reference:ArtifactReference,instruction:string){
 return `Edit this image with image.edit: artifact://${reference.artifactId}\n\n${instruction.trim()}`;
}
export function imageEditRequest(text:string){
 const match=/^Edit this image with image\.edit: artifact:\/\/([a-zA-Z0-9_-]{1,128})\n\n([\s\S]+)$/.exec(text);
 return match?{artifactId:match[1]!,instruction:match[2]!}:null;
}
export function imageReferenceForRun(run:ActivityRun,earlier:readonly ImageOutput[]){
 const request=run.user&&imageEditRequest(run.user.text);
 return request?earlier.find(item=>item.profileId===run.user!.profileId&&item.workId===run.user!.workId&&item.reference.source==='session'&&item.reference.artifactId===request.artifactId):undefined;
}
export function imageRunState(run:ActivityRun,active:boolean){
 const actions=toolActions(run.items).filter(action=>['image.generate','image.edit'].includes(action.records[0]!.name));
 const action=actions.at(-1),last=action?.records.at(-1);
 if(!last)return undefined;
 return {active,state:last.state==='running'?(active?'running':'interrupted'):last.state,editing:last.name==='image.edit',startedAt:action!.records[0]!.timestamp} as const;
}
/** Remove only redundant display lines for images actually represented by a retained canvas.
 * Unknown references, prose, and fenced code remain visible. Never load URLs from Markdown. */
export function imageResponseText(text:string,images:readonly ImageOutput[]){
 if(!images.length)return text;
 const ids=new Set(images.map(item=>item.reference.artifactId));
 let fence:string|null=null;
 const lines=text.split('\n').filter(line=>{
  const marker=/^\s*(`{3,}|~{3,})/.exec(line)?.[1];
  if(marker){if(!fence)fence=marker;else if(marker[0]===fence[0]&&marker.length>=fence.length)fence=null;return true;}
  if(fence)return true;
  const embed=/^\s*!\[[^\]]*\]\(artifact:\/\/([a-zA-Z0-9_-]+)\)\s*$/.exec(line);
  if(embed&&ids.has(embed[1]!))return false;
  const bullet=/^\s*[-*]\s+artifact:\/\/([a-zA-Z0-9_-]+)(?::([a-zA-Z0-9_-]+))?\s+\(image,[^)]*\)\s*-\s*[^\n]*$/.exec(line);
  return !(bullet&&ids.has(bullet[1]!)&&(!bullet[2]||bullet[2]===bullet[1]));
 });
 return lines.join('\n').replace(/(?:^|\n)Artifacts:\s*$/,'').trim();
}
