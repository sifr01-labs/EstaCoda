import {ControlProtocolError} from './envelopes.js';
export type TelegramSettings={enabled:boolean;authorization:'allowlist'|'pairing';allowedUserIds:string[];allowedChatIds:string[];
 secureInputMode:'protected-handoff'|'direct-dm'|'disabled';directDmAcknowledged:boolean;streaming:boolean;pollTimeoutSeconds:number};
export type TelegramDraft={draftId:string;expiresInMs:number;settings:TelegramSettings;credentialState:'staged'|'existing'|'missing'};
export type TelegramReview={windowId:string;generation:number;candidateId?:string;settings:TelegramSettings};
export function validateTelegramSettings(settings:TelegramSettings):void{
 const users=settings.allowedUserIds,chats=settings.allowedChatIds;
 if(!Array.isArray(users)||!Array.isArray(chats)||users.length>1000||chats.length>1000||new Set(users).size!==users.length||new Set(chats).size!==chats.length||users.some(id=>!/^\d{1,20}$/.test(id))||chats.some(id=>!/^\-?\d{1,20}$/.test(id))||
 !['allowlist','pairing'].includes(settings.authorization)||settings.enabled&&settings.authorization==='allowlist'&&!users.length&&!chats.length||
 !['protected-handoff','direct-dm','disabled'].includes(settings.secureInputMode)||settings.secureInputMode==='direct-dm'&&!settings.directDmAcknowledged||
 !Number.isInteger(settings.pollTimeoutSeconds)||settings.pollTimeoutSeconds<1||settings.pollTimeoutSeconds>50)throw new ControlProtocolError('-32602');
}
