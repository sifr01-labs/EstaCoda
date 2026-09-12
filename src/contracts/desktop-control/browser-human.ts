/** Narrow operator protocol. No browser endpoints, script, modifiers or arbitrary CDP. */
export type HumanBrowserInput={kind:'pointer';frameId:string;x:number;y:number}|{kind:'key';frameId:string;key:string};
export type HumanBrowserLease={id:string;generation:number};
export type HumanBrowserCommand={browserId:string;holder:string}&(
 {action:'acquire'}|{action:'renew';lease:HumanBrowserLease}|{action:'release';lease:HumanBrowserLease}|
 {action:'observe';lease:HumanBrowserLease;sequence:number}|{action:'input';lease:HumanBrowserLease;sequence:number;input:HumanBrowserInput});
export type HumanBrowserFrame={frameId:string;url:string;title:string;image:string;observedAt:string};
export type HumanBrowserResult={lease:HumanBrowserLease|null;frame:HumanBrowserFrame|null;state:'human'|'agent'};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const id=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/u.test(v);
export const humanBrowserKey=(key:unknown):key is string=>typeof key==='string'&&(['Enter','Tab','Backspace','Delete','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','Escape'].includes(key)||([...key].length===1&&!/[\p{C}]/u.test(key)));
export function validateHumanBrowserInput(value:unknown):asserts value is HumanBrowserInput{
 if(!object(value)||!id(value.frameId))throw new Error('Invalid browser input.');
 if(value.kind==='pointer'){
  if(Object.keys(value).sort().join(',')!=='frameId,kind,x,y'||![value.x,value.y].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<1))throw new Error('Invalid browser pointer.');
 }else if(value.kind!=='key'||Object.keys(value).sort().join(',')!=='frameId,key,kind'||!humanBrowserKey(value.key))throw new Error('Invalid browser key.');
}
export function validateHumanBrowserCommand(value:unknown):asserts value is HumanBrowserCommand{
 if(!object(value)||!id(value.browserId)||!id(value.holder)||!['acquire','renew','release','observe','input'].includes(String(value.action)))throw new Error('Invalid browser command.');
 const keys=['action','browserId','holder'];
 if(value.action!=='acquire'){keys.push('lease');if(!object(value.lease)||Object.keys(value.lease).sort().join(',')!=='generation,id'||!id(value.lease.id)||!Number.isSafeInteger(value.lease.generation)||Number(value.lease.generation)<1)throw new Error('Invalid browser lease.');}
 if(value.action==='observe'||value.action==='input'){keys.push('sequence');if(!Number.isSafeInteger(value.sequence)||Number(value.sequence)<1)throw new Error('Invalid browser sequence.');}
 if(value.action==='input'){keys.push('input');validateHumanBrowserInput(value.input);}
 if(Object.keys(value).sort().join(',')!==keys.sort().join(','))throw new Error('Unexpected browser command fields.');
}

/** Runtime-projected inventory; references are scoped to this runtime, never CDP target IDs. */
export type BrowserWorkspaceState = {
 supported:boolean; reason:string|null; sessions:Array<{id:string;tabs:Array<{ref:string;url:string;title:string;controlled:boolean;closable:boolean}>}>;
};
export type BrowserWorkspaceAction = {kind:'list'}|{kind:'back'|'forward'|'reload'}|{kind:'navigate'|'create';url:string}|{kind:'close-session'}|{kind:'new-tab';url:string}|{kind:'switch-tab'|'close-tab';tabRef:string};
export function validateBrowserWorkspaceAction(value:unknown):asserts value is BrowserWorkspaceAction {
 if(!object(value))throw new Error('Invalid browser workspace action.');
 const fields=value.kind==='navigate'||value.kind==='create'||value.kind==='new-tab'?['kind','url']:value.kind==='switch-tab'||value.kind==='close-tab'?['kind','tabRef']:['kind'];
 if(!['list','navigate','back','forward','reload','create','close-session','new-tab','switch-tab','close-tab'].includes(String(value.kind))||Object.keys(value).sort().join(',')!==fields.sort().join(','))throw new Error('Invalid browser workspace action.');
 if(fields.includes('url')&&(typeof value.url!=='string'||value.url.length<1||value.url.length>2048))throw new Error('Invalid browser address.');
 if(fields.includes('tabRef')&&(typeof value.tabRef!=='string'||!/^@t[1-9][0-9]{0,8}$/.test(value.tabRef)))throw new Error('Invalid browser tab.');
}
