import {ControlProtocolError} from './envelopes.js';
export type TelegramSettings={removeConfiguration?:boolean;deleteCredential?:boolean;enabled:boolean;authorization:'allowlist'|'pairing';allowedUserIds:string[];allowedChatIds:string[];
 secureInputMode:'protected-handoff'|'direct-dm'|'disabled';directDmAcknowledged:boolean;streaming:boolean;pollTimeoutSeconds:number};
export type TelegramDraft={draftId:string;expiresInMs:number;settings:TelegramSettings;credentialState:'staged'|'existing'|'missing'};
export type TelegramReview={windowId:string;generation:number;candidateId?:string;settings:TelegramSettings};
export function validateTelegramSettings(settings:TelegramSettings):void{
 if(settings.removeConfiguration&&settings.enabled||settings.deleteCredential&&!settings.removeConfiguration)throw new ControlProtocolError('-32602');
 const users=settings.allowedUserIds,chats=settings.allowedChatIds;
 if(!Array.isArray(users)||!Array.isArray(chats)||users.length>1000||chats.length>1000||new Set(users).size!==users.length||new Set(chats).size!==chats.length||users.some(id=>!/^\d{1,20}$/.test(id))||chats.some(id=>!/^\-?\d{1,20}$/.test(id))||
 !['allowlist','pairing'].includes(settings.authorization)||settings.enabled&&settings.authorization==='allowlist'&&!users.length&&!chats.length||
 !['protected-handoff','direct-dm','disabled'].includes(settings.secureInputMode)||settings.secureInputMode==='direct-dm'&&!settings.directDmAcknowledged||
 !Number.isInteger(settings.pollTimeoutSeconds)||settings.pollTimeoutSeconds<1||settings.pollTimeoutSeconds>50)throw new ControlProtocolError('-32602');
}

export type TelegramVerify={windowId:string;generation:number;candidateId?:string};
export type TelegramVerification={state:'passed'|'failed';reason:'none'|'credential_missing'|'invalid_credential'|'invalid_response'|'unavailable'|'cancelled';verifiedAt:number|null;botUsername:string|null;latencyMs:number};
export type ConnectionOperation={operationId:string;action:string;state:'completed'|'failed'|'uncertain'|'unknown'};
export type GatewayAction='install'|'start'|'stop'|'restart';
export type GatewayDiagnostics={service:'installed'|'absent'|'unknown';manager:'launchd'|'systemd-user'|'systemd-system'|'none';runtime:'running'|'stopped'|'disconnected';polling:'unknown'|'starting'|'healthy'|'degraded'|'stopped';observedAt:number|null};

export type TelegramOperationAction='pairingCreate'|'pairingCancel'|'sync'|'test';
export type TelegramPairing={code:string|null;expiresAt:number|null};

export type TelegramSession={sessionId:string;workId:string;title:string;attached:boolean};
export type TelegramSessionDetails={codes:{code:string;expiresAt:number}[];attachments:{id:string;attachedAt:number}[]};
