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
