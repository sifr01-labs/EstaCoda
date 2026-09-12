import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolveProfileStateHome} from './profile-home.js';
import {presentEnvSecretNames,readEnvSecretValue} from './env-secret-store.js';
/** Explicit profile snapshot: never borrow values left in process.env by another profile. */
export async function profileHeaderEnvironment(input:{homeDir:string;profileId:string}):Promise<Record<string,string>>{
 let file;try{file=await open(resolveProfileStateHome(input).envPath,constants.O_RDONLY|constants.O_NOFOLLOW);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {};throw error;}
 let content:string;try{if(!(await file.stat()).isFile())throw new Error('Invalid credential file');const data=Buffer.alloc(1_048_577);let size=0;while(size<data.length){const part=await file.read(data,size,data.length-size,size);if(!part.bytesRead)break;size+=part.bytesRead;}if(size>1_048_576)throw new Error('Credential file exceeds inspection bound');content=new TextDecoder('utf8',{fatal:true}).decode(data.subarray(0,size));}finally{await file.close();}
 return Object.fromEntries(presentEnvSecretNames(content).flatMap(name=>{const value=readEnvSecretValue(content,name);return value===undefined?[]:[[name,value]];}));
}
export function resolveHeaderReferences(headers:Record<string,string>|undefined,refs:Record<string,string>|undefined,environment:Readonly<Record<string,string|undefined>>):{headers:Record<string,string>;configured:boolean}{
 const result={...headers};for(const [name,ref] of Object.entries(refs??{})){
  if(!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name)||! /^[A-Z][A-Z0-9_]{1,127}$/.test(ref))return {headers:{},configured:false};
  const value=Object.hasOwn(environment,ref)?environment[ref]:undefined;if(!value||/[\r\n\0]/u.test(value))return {headers:{},configured:false};result[name]=value;
 }return {headers:result,configured:true};
}
