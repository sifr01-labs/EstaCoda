import {acquireGatewayLock,releaseGatewayLock} from '../../../src/gateway/gateway-lock.ts';
import {SharedSessionHost} from '../../../src/gateway/shared-session-host.ts';
import {ControlReceipts} from '../../../src/gateway/control-receipts.ts';
import {startPrivateControl} from '../../../src/gateway/private-control.ts';
import {SQLiteTaskStore} from '../../../src/tasks/sqlite-task-store.ts';
import {desktopCreateTask} from '../../../src/gateway/desktop-task-create.ts';
import {desktopTaskControl} from '../../../src/gateway/desktop-task-controls.ts';
import {desktopModelControl} from '../../../src/gateway/desktop-model-controls.ts';
import {loadRuntimeConfig} from '../../../src/config/runtime-config.ts';
import {validateSessionWorkspaceOwnership} from '../../../src/session/session-workspace-ownership.ts';
import {WorkspaceTrustStore} from '../../../src/security/workspace-trust-store.ts';
import type {SQLiteSessionDB} from '../../../src/session/sqlite-session-db.ts';
import type {GatewayApprovalQueue} from '../../../src/gateway/approval-queue.ts';
import type {Runtime} from '../../../src/runtime/create-runtime.ts';
/** Real private transport, durable controls and operator services; deterministic runtime avoids paid calls. */
export async function nativeWorkOwner(input:{home:string;directory:string;db:SQLiteSessionDB;queue:GatewayApprovalQueue;version:string;instanceId:string;received:string[]}){
 const {db,home}=input;const lock=await acquireGatewayLock({gatewayStatePath:input.directory});if(!lock.acquired||!lock.instanceId)throw Error('Test owner lock unavailable');const instanceId=lock.instanceId;await new WorkspaceTrustStore({homeDir:home}).grant(home);
 const tasks=new SQLiteTaskStore({db:db.db,profileId:'default'});
 const context=async()=>{const loaded=await loadRuntimeConfig({homeDir:home,profileId:'default',workspaceRoot:home,configurationInspection:true});return{config:loaded.config,providerRegistry:loaded.providerRegistry,homeDir:home,profileId:'default'};};
 const host=new SharedSessionHost({profileId:'default',sessionDb:db,receipts:new ControlReceipts(db.db,'default',instanceId),approvalQueue:input.queue,
 validateTarget:async request=>{const session=(await db.getSessionForProfile(request.sessionId,'default'))!;await validateSessionWorkspaceOwnership({homeDir:home,profileId:'default',session,workspaceRoot:home});},
 modelControl:async request=>desktopModelControl({request,profileId:'default',sessionDb:db,tasks,context:await context(),invalidate:async()=>{}}),
 taskControl:async request=>request.method==='task.create'?desktopCreateTask({request,store:tasks,session:(await db.getSessionForProfile(request.sessionId,'default'))!,context:await context()}):desktopTaskControl(tasks,request),
 channelApproval:async()=>{throw Error('No matching channel action');},
 acquire:async sessionId=>({sessionId,dispose:async()=>{},grantApproval:async()=>{},handle:async(args:any)=>{
 input.received.push(args.text);await db.appendMessage({sessionId,role:'user',content:args.text});args.onDelta('Inspecting attached evidence.');
 const target=(await db.getSessionForProfile(sessionId,'default'))!.executionTarget!;
 const decision=await args.onApprovalRequest({tool:{name:'files.read'},input:{},riskClass:'read-only-local',targetSummary:'Read attached evidence',pendingApproval:{schemaVersion:1,id:'native-action',actionKey:'d'.repeat(64),authorizationRevision:0,expiresAt:Date.now()+60000,executionScope:{schemaVersion:1,profileId:'default',sessionId,workspaceIdentityHash:target.workspace.identityHash,authorityFingerprint:'e'.repeat(64),environmentInstanceId:instanceId,surfaceKey:'local'}}});
 await db.appendMessage({sessionId,role:'agent',content:decision==='approved'?'Attached evidence reviewed.':'Review denied.'});return{text:'Settled'};
 }}) as unknown as Runtime});
 const transport=await startPrivateControl({directory:input.directory,profileId:'default',instanceId:instanceId,version:input.version,targetGeneration:true,handle:request=>host.handle(request)});
 return{instanceId,async close(){await host.close();await transport.close();await releaseGatewayLock({gatewayStatePath:input.directory},instanceId);}};
}
