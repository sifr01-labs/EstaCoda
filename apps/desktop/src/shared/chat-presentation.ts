import {exactKeys,isControlId,isRecord,type TargetReference} from '@estacoda/control-protocol';
export type SavedDraft={targetLabel?:string;kind?:'session'|'task';id:string;text:string;model:string;target?:TargetReference;modelSelection?:{providerId:string;modelId:string}|null};
export type ChatMetadata={title?:string;archived?:boolean;unread?:boolean};
export type ChatPresentation={selected:string;drafts:Record<string,SavedDraft>;chats:Record<string,ChatMetadata>};
export const emptyChatPresentation=():ChatPresentation=>({selected:'welcome',drafts:{},chats:{}});
export function validChatPresentation(value:unknown):value is ChatPresentation{
 if(!isRecord(value)||!exactKeys(value,['selected','drafts','chats'])||!isControlId(value.selected)||!isRecord(value.drafts)||!isRecord(value.chats)||Object.keys(value.drafts).length>200||Object.keys(value.chats).length>2000||JSON.stringify(value).length>1_000_000)return false;
 for(const [id,d]of Object.entries(value.drafts)){
  if(!isControlId(id)||!isRecord(d)||!exactKeys(d,['id','text','model'],['target','modelSelection','kind','targetLabel'])||!isControlId(d.id)||typeof d.text!=='string'||d.text.length>100_000||typeof d.model!=='string'||d.model.length>200)return false;
  if(d.targetLabel!==undefined&&(typeof d.targetLabel!=='string'||d.targetLabel.length>512))return false;
  if(d.kind!==undefined&&d.kind!=='session'&&d.kind!=='task')return false;
  if(d.target!==undefined&&(!isRecord(d.target)||!exactKeys(d.target,['targetId','targetGeneration'])||!isControlId(d.target.targetId)||!Number.isSafeInteger(d.target.targetGeneration)||Number(d.target.targetGeneration)<1))return false;
  const m=d.modelSelection;if(m!==undefined&&m!==null&&(!isRecord(m)||!exactKeys(m,['providerId','modelId'])||!isControlId(m.providerId)||typeof m.modelId!=='string'||!m.modelId.length||m.modelId.length>200))return false;
 }
 return Object.entries(value.chats).every(([id,c])=>isControlId(id)&&isRecord(c)&&exactKeys(c,[],['title','archived','unread'])&&(c.title===undefined||typeof c.title==='string'&&c.title.trim().length>0&&c.title.length<=160)&&(c.archived===undefined||typeof c.archived==='boolean')&&(c.unread===undefined||typeof c.unread==='boolean'));
}
