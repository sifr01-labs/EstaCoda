import type {WorkProjection,HumanBrowserCommand,HumanBrowserResult} from '../contracts/desktop-control/index.js';
import {browserOwner} from './browser-view.js';
import {callPrivateControl} from '../gateway/private-control.js';
import {resolveProfileStateHome} from '../config/profile-home.js';
import {randomUUID} from 'node:crypto';
/** Authenticated forwarding only. Never starts a host or constructs a browser runtime. */
export async function browserControl(input:{homeDir:string;profileId:string;version:string},work:WorkProjection,command:HumanBrowserCommand,signal:AbortSignal):Promise<HumanBrowserResult>{
 const session=await browserOwner(input,work,signal);
 return await callPrivateControl({directory:resolveProfileStateHome(input).gatewayStatePath,profileId:input.profileId,version:input.version,requireTargetGeneration:true,signal,
  request:{method:'browser.control',sessionId:session.id,targetId:session.executionTarget!.targetId,targetGeneration:session.executionTarget!.targetGeneration,operationId:randomUUID(),browserControl:command}}) as HumanBrowserResult;
}
