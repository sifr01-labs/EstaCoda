import {CONNECTION_OPERATION_ISSUES} from './telegram.js';
import {SETUP_STATES} from './onboarding.js';
import {SETTINGS_ACTIONS,SETTINGS_SECTIONS} from './settings.js';
import {EVIDENCE_SUMMARY_CODES,EVIDENCE_LIMITATION_CODES} from './evidence.js';
import {validateHumanBrowserCommand} from './browser-human.js';
import {AUXILIARY_SLOTS, candidateRouteBinding, type CandidateRoute} from './model-setup.js';
import { CONTROL_LIMITS, ControlProtocolError, DESKTOP_PROTOCOL_VERSION, assertEnvelope, exactKeys, isControlId, isControlOperationId, isRecord, type RpcFailure } from "./envelopes.js";
import { CONTROL_EVENTS, CONTROL_METHODS, assertInitializeParams, isControlCursor, isProtocolVersion, type Capabilities, type ControlEventType } from "./bootstrap.js";
import { ACTION_IDS, WORK_STATUSES, ROUTE_HEALTH_STATES } from "./projections.js";
import type { ControlEvent, EventNotification, MethodContracts, MethodRequest, MethodSuccess, OperationReceipt } from "./methods.js";

type Check = (value: unknown) => boolean;
const text = (max: number, min = 0): Check => (v) => typeof v === "string" && v.length >= min && v.length <= max;
const integer = (min = 0, max = Number.MAX_SAFE_INTEGER): Check => (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const choice = (values: readonly string[]): Check => (v) => typeof v === "string" && values.includes(v);
const boolean: Check = (v) => typeof v === "boolean";
const nullable = (check: Check): Check => (v) => v === null || check(v);
const array = (check: Check, max = 100, min = 0): Check => (v) => Array.isArray(v) && v.length >= min && v.length <= max && v.every(check);
const unique = (check: Check, max = 64, min = 0): Check => (v) => array(check, max, min)(v) && new Set(v as unknown[]).size === (v as unknown[]).length;
const shape = (required: Record<string, Check>, optional: Record<string, Check> = {}): Check => (v) =>
  isRecord(v) && exactKeys(v, Object.keys(required), Object.keys(optional)) &&
  Object.entries(required).every(([key, check]) => check(v[key])) &&
  Object.entries(optional).every(([key, check]) => !Object.hasOwn(v, key) || check(v[key]));
const id = isControlId;
const cursorToken: Check = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,512}$/.test(v);
const capabilities = shape({ methods: unique(choice(CONTROL_METHODS),256), events: unique(choice(CONTROL_EVENTS)) });
const settingValue:Check=v=>v===null||text(4096)(v)||boolean(v)||typeof v==='number'&&Number.isFinite(v)||array(text(2048),128)(v);
const settingChange=shape({fieldId:text(240,1),selectors:array(text(128,1),8),value:settingValue});
const settingField=shape({id:text(240,1),section:choice(SETTINGS_SECTIONS),path:array(text(128,1),12),kind:choice(['scalar','text','number','boolean','choice','strings','secret'])},{choices:array(settingValue,128),min:(v)=>typeof v==='number'&&Number.isFinite(v),max:(v)=>typeof v==='number'&&Number.isFinite(v),envName:text(128,1)});
const settingsAction=shape({action:choice(SETTINGS_ACTIONS),subject:text(4096,1),value:text(4096)});
const settingsBinding=shape({draftId:id,windowId:id,generation:integer(1)});
const scheduleProjection=shape({id,name:text(240),objective:text(4096),schedule:text(240),kind:choice(['once','interval','cron']),status:choice(['active','paused','completed']),delivery:text(240),workspace:nullable(text(4096)),model:nullable(shape({provider:nullable(text(240)),model:text(240)})),nextRunAt:nullable(text(80)),lastRunAt:nullable(text(80)),lastStatus:nullable(choice(['succeeded','failed'])),runCount:integer(),runRequested:boolean,script:boolean,channelBound:boolean});
const scheduleExecution=shape({id,workId:nullable(id),startedAt:text(80),completedAt:nullable(text(80)),status:choice(['success','failed','cancelled','skipped','running']),failure:nullable(text(120)),delivery:array(shape({destination:text(240),success:boolean}),16)});
const targetId:Check=(v)=>typeof v==='string'&&/^target_[a-f0-9-]{36}$/.test(v);
const target = shape({ targetId: id, targetGeneration: integer(1) });
const scheduleDraft=shape({name:text(240,1),objective:text(4096,1),schedule:text(120,1),target:nullable(target),model:nullable(shape({provider:text(160),model:text(160,1)})),delivery:text(240,1),skills:array(text(160,1),32),toolsets:nullable(array(text(80,1),32)),contextFrom:array(id,32),repeat:nullable(integer(1,1000000)),script:nullable(text(4096,1)),scriptArgs:array(text(512),32),scriptTimeoutMs:nullable(integer(1,3600000)),noAgent:boolean});
const scheduleAction:Check=v=>shape({action:choice(['save']),draft:scheduleDraft},{id})(v)||shape({action:choice(['delete','enable','disable','run-now']),id})(v);
const scheduleReview=shape({reviewId:id,action:scheduleAction,definition:nullable(scheduleDraft),profileId:id,workspace:nullable(text(4096)),nextRunAt:nullable(text(80)),authority:text(80),spendUsd:nullable((v)=>typeof v==='number'&&Number.isFinite(v)&&v>=0),model:text(400),expiresAt:integer()});
const targetDetailsFields={targetId:id,targetGeneration:integer(1),kind:choice(['local','temporary-copy','git-worktree']),label:text(240,1),workingRoot:text(4096,1),sourceRoot:text(4096,1),status:choice(['available','archived']),readiness:choice(['ready','untrusted','unavailable','archived']),managed:boolean};
const targetDetails=shape(targetDetailsFields);
const targetInspection=shape({...targetDetailsFields,dirty:nullable(boolean),borrowers:integer(),branch:nullable(text(200,1)),cleanup:nullable(choice(['retained','removed']))});
const targetOperation=shape({operationId:id,action:choice(['create','archive','cleanup','unknown']),state:choice(['completed','uncertain','unknown']),target:nullable(target)});
const targetCreation=shape({reviewId:id,operationId:id,source:target,sourceRoot:text(4096,1),destination:text(4096,1),branch:text(200,1),baseCommit:text(64,40),expiresAt:integer()});
const targetProjection = shape({ targetId: id, targetGeneration: integer(1), label: text(240, 1), isolation: choice(["host", "sandboxed", "unknown"]) }, {approvalMode:choice(["strict","adaptive","open"])});
const actionShape = shape({ id: choice(ACTION_IDS), enabled: boolean }, { reason: text(2_048, 1), stepId: id, sessionId: id });
const actions: Check = (v) => array((a) => actionShape(a) && isRecord(a) && (a.enabled === true || typeof a.reason === "string"), 128)(v) &&
  new Set((v as { id: string; stepId?: string }[]).map(a => `${a.id}:${a.stepId ?? ''}`)).size === (v as unknown[]).length;
const work = shape({ id, canonicalId: id, profileId: id, kind: choice(["session", "task", "task_attempt", "schedule", "scheduled_execution", "evolution_review"]),
  title: text(240, 1), status: choice(WORK_STATUSES), updatedAt: integer(), target: nullable(targetProjection) }, { reason: text(2_048), parentWorkId: id, actions, modelBinding:shape({sessionId:id},{taskId:id}) });
const usage = shape({ reportedTokens: nullable(integer()), cost: nullable(shape({ amount: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0,
  currency: (v) => typeof v === "string" && /^[A-Z]{3}$/.test(v) })) });
const evidence = shape({ state: choice(["verified", "unverified", "partial", "failed"]), summary: text(2_048), artifactIds: unique(id, 100) });
const activityBase = { id, workId: id, profileId: id, sequence: integer(), timestamp: integer() };
const activityVariants: Record<string, Check> = {
  message: shape({ ...activityBase, kind: choice(["message"]), role: choice(["user", "assistant"]), text: text(16_384) }, {phase:choice(["progress","response"])}),
  assistant_delta: shape({ ...activityBase, kind: choice(["assistant_delta"]), text: text(4_096, 1) }),
  tool: shape({ ...activityBase, kind: choice(["tool"]), name: text(160, 1), state: choice(["running", "completed", "failed", "cancelled"]), summary: text(2_048) }, {callId:text(256,1)}),
  artifact: shape({...activityBase,kind:choice(["artifact"]),reference:shape({source:choice(["session","task"]),ownerId:id,artifactId:id}),label:text(160),bytes:integer(),mimeType:text(160,1)}),
  plan: shape({ ...activityBase, kind: choice(["plan"]), steps: array(shape({ id, title: text(240, 1), status: choice(["pending", "running", "completed", "failed"]) }), 64) }),
  result: shape({ ...activityBase, kind: choice(["result"]), status: choice(WORK_STATUSES), evidence, usage }, {recoveredErrors:boolean}),
  status: shape({ ...activityBase, kind: choice(["status"]), status: choice(WORK_STATUSES) }, { reason: text(2_048) }),
};
const activity: Check = (v) => isRecord(v) && typeof v.kind === "string" && Object.hasOwn(activityVariants, v.kind) && activityVariants[v.kind]!(v);
const approval = shape({ id, sessionId: id, target, actionSummary: text(2_048, 1), scope: choice(["once"]), decisions: unique(choice(["approved", "denied"]), 2, 1) });
const inboxShape = shape({ id, profileId: id, workId: nullable(id), kind: choice(["approval", "input", "trust", "setup", "failure", "evolution", "delivery"]),
  title: text(240, 1), summary: text(2_048), createdAt: integer(), approval: nullable(approval) }, { actions });
const inbox: Check = (v) => inboxShape(v) && isRecord(v) && (v.kind === "approval" ? v.approval !== null && v.workId !== null : v.approval === null);
const nonnegative: Check = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const modelCatalog = shape({configured:boolean,catalogOnly:boolean,contextTokens:nullable(integer()),outputTokens:nullable(integer()),tools:boolean,vision:boolean,
  lifecycle:choice(['available','deprecated','retired']),source:choice(['models-dev','configured','manual','fallback-known']),
  price:nullable(shape({inputPerMillion:nullable(nonnegative),outputPerMillion:nullable(nonnegative)}))});
const modelShape = shape({ id: text(200, 1), providerId: id, label: text(240, 1), runnable: boolean,
  credentialState: choice(["not_required", "missing", "present", "expired"]), role: nullable(choice(["primary", "fallback", "auxiliary", "session_override"])) }, {catalog:modelCatalog, health:choice(ROUTE_HEALTH_STATES)});
const model: Check = (v) => modelShape(v) && isRecord(v) && (!v.runnable ||
  ((v.credentialState === "present" || v.credentialState === "not_required") &&
    (!isRecord(v.catalog) || (!v.catalog.catalogOnly && v.catalog.lifecycle !== 'retired'))));
const provider = shape({ id, label: text(240, 1), authMethods: unique(choice(["api_key", "oauth", "none"]), 3, 1), state: choice(["ready", "unconfigured", "repair_required", "unknown"]) }, {health:choice(ROUTE_HEALTH_STATES),metadata:shape({configurable:boolean,runnable:boolean,catalogOnly:boolean,apiMode:text(80,1),defaultEndpoint:nullable(text(2048,1))})});
const telegramSettings=shape({enabled:boolean,authorization:choice(['allowlist','pairing']),allowedUserIds:unique(text(20,1),1000),allowedChatIds:unique(text(21,1),1000),secureInputMode:choice(['protected-handoff','direct-dm','disabled']),directDmAcknowledged:boolean,streaming:boolean,pollTimeoutSeconds:integer(1,50)},{removeConfiguration:boolean,deleteCredential:boolean});
const connection = shape({ id, profileId: id, channel: choice(["telegram", "discord", "email", "whatsapp"]),
  configurationState: choice(["configured", "unconfigured", "repair_required"]), runtimeState: choice(["running", "stopped", "disconnected", "unknown"]),
  authorizationState: choice(["denied", "configured", "pairing_required", "unknown"]), summary: text(2_048) }, {
 telegram:shape({status:choice(["disabled","credential_missing","authorization_missing","pairing_pending","ready"]),allowedUsers:integer(0,1000),allowedChats:integer(0,1000),pairingExpiresAt:nullable(integer()),polling:choice(["unknown","starting","healthy","degraded","stopped"]),observedAt:nullable(integer()),lastVerifiedAt:nullable(integer())},{configured:boolean}) });
const libraryProposal=shape({id,skillName:text(240,1),status:choice(['proposed','promoted','rejected']),approval:text(80),reason:text(2048),risk:text(80),changeKind:text(80)});
const libraryGate=shape({status:choice(['passed','failed','not-run']),score:nullable((v)=>typeof v==='number'&&Number.isFinite(v)),threshold:nullable((v)=>typeof v==='number'&&Number.isFinite(v)),failures:array(text(512),20)});
const librarySkill=shape({id,name:text(240,1),description:text(2048),source:choice(['local','bundled','external']),version:nullable(text(80)),requiredToolsets:array(text(80),64),optionalToolsets:array(text(80),64)});
const page = (check: Check): Check => shape({ items: array(check), nextCursor: nullable(cursorToken) });
const pageParams = { limit: integer(1, 100) };
const optionalPage = { cursor: cursorToken };
const sessionParams = { operationId: isControlOperationId, sessionId: id, target };
const mutationMethods = ["tasks.create", "sessions.setModel", "tasks.setModel", "tasks.pause", "tasks.resume", "tasks.cancel", "tasks.retry", "tasks.guide", "sessions.start", "sessions.resume", "sessions.send", "sessions.cancelTurn", "approvals.resolve"] as const;
const receiptShape = shape({ operationId: isControlOperationId, profileId: id, sessionId: id, target, method: choice(mutationMethods),
  state: choice(["accepted", "dispatched", "completed", "uncertain", "unknown", "expired"]), cancellation: choice(["not_requested", "requested", "confirmed"]) }, { taskId: id });
const receipt: Check = (v) => receiptShape(v) && isRecord(v) &&
  (String(v.method).startsWith("tasks.") ? id(v.taskId) : v.taskId === undefined) &&
  (v.method === "sessions.cancelTurn" || v.cancellation === "not_requested") &&
  (!["unknown", "expired"].includes(String(v.state)) || v.cancellation === "not_requested");
const initializeResult = shape({ protocolVersion: isProtocolVersion, serviceVersion: (v) => typeof v === "string" && /^[A-Za-z0-9_.+-]{1,80}$/.test(v),
  profileId: id, instanceId: id, capabilities,
  limits: shape({ frameBytes: integer(1, CONTROL_LIMITS.frameBytes), subscriptions: integer(1, 32), replayEvents: integer(1, 256) }) });
const bootstrap = shape({ profile: shape({ id, label: text(240, 1), configuration: choice(["unconfigured", "ready", "repair_required"]) }),
  runtime: shape({ state: choice(["stopped", "starting", "ready", "disconnected", "incompatible", "unavailable"]) }), capabilities, cursor: isControlCursor });
const subscribeResult: Check = (v) => shape({ state: choice(["subscribed"]), subscriptionId: id, cursor: isControlCursor })(v) ||
  shape({ state: choice(["snapshot_required"]), reason: choice(["instance_changed", "stream_changed", "cursor_expired", "overflow"]) })(v);
const initialize: Check = (v) => { try { assertInitializeParams(v); return true; } catch { return false; } };
const candidateRoute=shape({providerId:id,modelId:text(200,1),endpoint:text(2048,1),authMethod:choice(['api_key','oauth','none']),apiMode:choice(['openai_chat_completions','openai_responses','custom_openai_compatible']),allowPrivateEndpoint:boolean},{enableNetwork:boolean,contextWindowTokens:integer(1,1000000000),maxTokens:integer(1,1000000000)});
const modelRouteDraftShape=shape({draftId:id,expiresInMs:integer(1,900000),credentialState:choice(['staged','existing','not_required']),role:choice(['provider','primary','fallback','fallback_order','auxiliary','auxiliary_mode'])},{route:candidateRoute,slot:choice(AUXILIARY_SLOTS)});
const modelRouteDraft:Check=v=>modelRouteDraftShape(v)&&isRecord(v)&&(['fallback_order','auxiliary_mode'].includes(String(v.role))?v.route===undefined:candidateRoute(v.route))&&(['auxiliary','auxiliary_mode'].includes(String(v.role))?choice(AUXILIARY_SLOTS)(v.slot):v.slot===undefined);
const modelDraftBinding=shape({draftId:id,windowId:id,generation:integer(1)});
const connectionOperation=shape({operationId:id,action:text(80,1),state:choice(['completed','failed','uncertain','unknown'])},{issue:choice(CONNECTION_OPERATION_ISSUES),phase:choice(['preparing','installing','verifying'])});
const modelApplyReceipt=shape({operationId:id,state:choice(['applied','uncertain','unknown']),verification:choice(['configured','repair_required','not_tested'])},{issue:shape({providerId:id,modelId:text(200,1),reason:choice(['credential_required','authorization_expired','model_unavailable','configuration_unavailable'])})});
const oauthBinding=shape({authorizationId:id,windowId:id,generation:integer(1)});
const oauthStatusShape=shape({authorizationId:id,state:choice(['starting','pending','authorized','failed','cancelled','expired']),verificationUrl:nullable(choice(['https://auth.openai.com/codex/device'])),userCode:nullable((v)=>typeof v==='string' && /^[-A-Z0-9]{1,32}$/i.test(v)),candidateId:nullable(id)});
const oauthStatus:Check=v=>oauthStatusShape(v)&&isRecord(v)&&(v.state==='pending'?v.verificationUrl!==null&&v.userCode!==null:v.verificationUrl===null&&v.userCode===null)&&(v.state==='authorized'?v.candidateId!==null:v.candidateId===null);
const candidateVerification=shape({state:choice(['passed','failed','cancelled']),reason:choice(['none','unreachable','invalid_credential','model_unavailable','unsupported','incomplete','cancelled']),streaming:boolean,tools:boolean,latencyMs:integer(),inputTokens:nullable(integer()),outputTokens:nullable(integer()),estimatedCost:nullable(nonnegative)});
const artifactReference=shape({source:choice(['session','task']),ownerId:id,artifactId:id});
const artifactProjection=shape({reference:artifactReference,displayName:text(160),mimeType:text(160,1),bytes:integer(),sha256:text(64,64),createdAt:text(64,1),retention:choice(['retained','pruned','expired']),sourceOrigin:nullable(text(512)),workIds:array(id,3),target:nullable(target)},{sourceWorkspaceId:id,applicationTargetId:id,evidenceCallIds:array(text(256,1),64)});
const browserReference=shape({sessionId:id,browserId:id,eventId:integer(1),target});
const browserState=shape({reference:browserReference,url:nullable(text(2048)),title:nullable(text(160)),observedAt:text(64,1),readiness:choice(['loading','interactive','complete','unknown']),state:choice(['recorded','blocked']),lastAction:text(160),artifacts:array(artifactReference,16)});
const artifactPreview=shape({artifact:artifactProjection,integrity:choice(['verified','unavailable']),text:nullable(text(16384)),truncated:boolean,reason:nullable(text(2048))});
const contracts: { [M in keyof MethodContracts]: { params: Check; result: Check } } = {
  'connections.connectors': {params: value => shape({action:choice(['inspect','reconnect'])},{workId:id})(value) && isRecord(value) && (value.action==='inspect'||id(value.workId)), result:shape({state:choice(['not_loaded','ready','reconnecting','busy','failed','unavailable']),items:array(shape({id:text(160,1),state:choice(['not_loaded','ready','disabled','needs_attention']),toolCount:integer()}),128)})},
  "browser.control":{params:shape({workId:id,command:value=>{try{validateHumanBrowserCommand(value);return value.action!=='signin-deliver';}catch{return false;}}}),result:shape({lease:nullable(shape({id,generation:integer(1)})),state:choice(['human','agent','paused']),frame:nullable(shape({frameId:id,url:text(2048,1),title:text(160),image:text(60000,1),observedAt:text(64,1)},{readiness:choice(['loading','interactive','complete','unknown']),protectedFieldFocused:boolean,inputContextId:id,submitTargets:array(shape({ref:text(32,1),label:text(120)}),16)})),},{entry:shape({id,origin:text(2048,1)}),workspace:shape({supported:boolean,reason:nullable(text(512)),truncated:boolean,sessions:array(shape({id,tabs:array(shape({ref:text(32,1),url:text(2048,1),title:text(160),controlled:boolean,closable:boolean}),16)}),8)},{selectedSessionId:id})})},
  "browser.snapshot":{params:shape({workId:id,reference:browserReference}),result:shape({state:browserState,image:nullable(shape({mimeType:choice(['image/jpeg']),base64:text(60000,1),observedAt:text(64,1)})),reason:nullable(text(2048))})},
  "browser.list":{params:shape({workId:id}),result:shape({items:array(browserState,8),truncated:boolean})},
  "artifacts.list":{params:shape({},{cursor:text(40,1)}),result:shape({items:array(artifactProjection,32),nextCursor:nullable(text(40,1))})},
  "artifacts.get":{params:shape({reference:artifactReference}),result:artifactPreview},
  "artifacts.open":{params:shape({reference:artifactReference}),result:artifactPreview},
  "evidence.get":{params:shape({workId:id}),result:shape({workId:id,state:choice(['verified','unverified','partial','failed']),completion:choice(['completed','partial','failed','cancelled','unconfirmed']),summary:text(2048),truncated:boolean,artifacts:array(artifactReference,16),facts:array(shape({callId:text(256,1),tool:text(160,1),kind:choice(['read','mutation','validation','failure','unverified_mutation','unknown']),verifiedBy:nullable(text(256,1))}),64),limitations:array(text(2048),16)},{summaryCode:choice(EVIDENCE_SUMMARY_CODES),limitationCodes:array(choice(EVIDENCE_LIMITATION_CODES),16)})},
  "terminal.acquire":{params:shape({target}),result:shape({capabilityId:id,target,workingRoot:text(4096,1),backend:choice(['host','docker']),expiresAt:integer(),container:nullable(shape({id:text(64,64),user:text(40,1),endpoint:text(4096,1)}))})},
  "terminal.verify":{params:shape({capabilityId:id}),result:shape({expiresAt:integer()})},
  "terminal.release":{params:shape({capabilityId:id,settled:v=>v===true}),result:shape({released:boolean})},
  "diff.list":{params:shape({target}),result:shape({items:array(shape({path:text(1024,1),previousPath:nullable(text(1024,1)),stage:choice(['staged','unstaged','untracked']),status:choice(['added','modified','deleted','renamed','copied','type_changed','conflicted']),binary:nullable(boolean),previewable:boolean}),32),truncated:boolean})},
  "diff.patch":{params:shape({target,path:text(1024,1),stage:choice(['staged','unstaged','untracked'])}),result:shape({path:text(1024,1),stage:choice(['staged','unstaged','untracked']),binary:boolean,text:nullable(text(16384)),truncated:boolean})},
  "files.list":{params:shape({target,path:text(1024,1)},{cursor:text(1024,1)}),result:shape({items:array(shape({path:text(1024,1),name:text(255,1),kind:choice(['file','directory','symlink','special'])})),truncated:boolean},{nextCursor:text(1024,1)})},
  "files.preview":{params:shape({target,path:text(1024,1)}),result:shape({path:text(1024,1),size:integer(),binary:boolean,text:nullable(text(16384)),truncated:boolean})},
  "models.importOptions": {params:shape({sourceProfileId:id}),result:shape({items:array(shape({id,providerId:id,modelId:text(200,1),endpoint:text(2048,1),available:boolean,requiresSignIn:boolean}),33)})},
  "models.reviewImport": {params:shape({sourceProfileId:id,routeId:id,providerId:id,modelId:text(200,1),endpoint:text(2048,1),confirmed:(v)=>v===true,windowId:id,generation:integer(1)}),result:modelRouteDraft},
  "models.reviewConfigured": {params:shape({windowId:id,generation:integer(1),providerId:id,modelId:text(200,1),role:choice(["provider","primary","fallback","auxiliary"])},{slot:choice(AUXILIARY_SLOTS),fallbackToMain:boolean,verification:shape({endpoint:text(2048,1)})}),result:modelRouteDraft},
  "models.validateRoute": {params:shape({route:candidateRoute}),result:shape({valid:v=>v===true})},
  "models.refreshCatalog": {params:shape({networkApproved:v=>v===true}),result:shape({refreshed:boolean})},
  "models.oauthStart": {params:shape({windowId:id,generation:integer(1)}),result:oauthStatus},
  "models.oauthStatus": {params:oauthBinding,result:oauthStatus},
  "models.oauthCancel": {params:oauthBinding,result:shape({cancelled:boolean})},
  "models.workOverride": {params:shape({sessionId:id,target},{taskId:id}),result:shape({selection:nullable(shape({providerId:id,modelId:text(200,1)})),effective:choice(["next_turn","next_attempt"])})},
  "sessions.setModel": {params:shape({...sessionParams,selection:nullable(shape({providerId:id,modelId:text(200,1)}))}),result:receipt},
  "tasks.setModel": {params:shape({...sessionParams,taskId:id,selection:nullable(shape({providerId:id,modelId:text(200,1)}))}),result:receipt},
  "control.initialize": { params: initialize, result: initializeResult },
  "control.bootstrap": { params: shape({}), result: bootstrap },
  "control.subscribe": { params: shape({ after: isControlCursor, events: unique(choice(CONTROL_EVENTS), 64, 1) }), result: subscribeResult },
  "control.unsubscribe": { params: shape({ subscriptionId: id }), result: shape({ removed: boolean }) },
  "control.cancelRequest": { params: shape({ requestId: id }), result: shape({ cancellationRequested: boolean }) },
  "work.counts":{params:shape({}),result:shape({runningSessions:integer(),runningTasks:integer(),queuedTasks:integer(),approvals:integer(),attention:integer(),scheduled:nullable(integer()),asOf:integer()})},
  "work.usage":{params:shape({workId:id}),result:shape({scope:choice(['session','task','attempt']),reportedTokens:nullable(integer()),providerCalls:integer(),cost:nullable(shape({amount:v=>typeof v==='number'&&Number.isFinite(v)&&v>=0,currency:choice(['USD'])})),usageComplete:boolean,pricingComplete:boolean,context:nullable(shape({usedTokens:integer(),totalTokens:integer(1),provider:text(240,1),model:text(240,1)})),truncated:boolean,provisional:boolean})},
  "work.live": {params:shape({workId:id}),result:shape({active:boolean,turnId:nullable(id),text:text(16384),truncated:boolean})},
  "targets.list":{params:shape({},{cursor:targetId}),result:shape({items:array(targetDetails),truncated:boolean},{nextCursor:targetId})},
  "targets.inspect":{params:shape({target}),result:targetInspection},
  "targets.reviewCreate":{params:shape({source:target}),result:targetCreation},
  "targets.create":{params:shape({reviewId:id,source:target,trustNewPath:v=>v===true}),result:targetOperation},
  "targets.cancelReview":{params:shape({reviewId:id}),result:shape({cancelled:boolean})},
  "targets.execute":{params:shape({operationId:id,action:choice(['archive','cleanup']),target,confirmed:v=>v===true}),result:targetOperation},
  "targets.inspectOperation":{params:shape({operationId:id}),result:targetOperation},
  "work.targets": {params:shape({},{cursor:targetId,target}),result:shape({items:array(targetProjection),truncated:boolean},{nextCursor:targetId})},
  "work.list": { params: shape(pageParams, {...optionalPage, query:text(200),parentWorkId:id}), result: page(work) },
  "work.get": { params: shape({ workId: id }), result: work },
  "work.activity": { params: shape({ ...pageParams, workId: id }, optionalPage), result: page(activity) },
  "inbox.get":{params:shape({itemId:id}),result:inbox},
  "inbox.list": { params: shape(pageParams, optionalPage), result: page(inbox) },
  "models.auxiliary": {params:shape({}),result:shape({items:array(shape({slot:choice(AUXILIARY_SLOTS),mode:choice(['main','auto','dedicated','disabled']),providerId:nullable(id),modelId:nullable(text(200,1)),fallbackToMain:boolean,credentialState:choice(['missing','present','expired','not_required']),runnable:boolean}),5)})},
  "models.reviewAuxiliary": {params:shape({windowId:id,generation:integer(1),route:candidateRoute,slot:choice(AUXILIARY_SLOTS),fallbackToMain:boolean},{candidateId:id}),result:modelRouteDraft},
  "models.reviewAuxiliaryMode": {params:shape({windowId:id,generation:integer(1),slot:choice(AUXILIARY_SLOTS),mode:choice(['main','auto','disabled']),fallbackToMain:boolean}),result:modelRouteDraft},
  "models.fallbacks": {params:shape({}),result:shape({revision:id,items:array(shape({index:integer(0,31),providerId:id,modelId:text(200,1)}),32)})},
  "models.reviewFallback": {params:shape({windowId:id,generation:integer(1),route:candidateRoute},{candidateId:id}),result:modelRouteDraft},
  "models.reviewFallbackOrder": {params:shape({windowId:id,generation:integer(1),revision:id,order:unique(integer(0,31),32)}),result:modelRouteDraft},
  "models.reviewProvider": {params:shape({windowId:id,generation:integer(1),route:candidateRoute},{candidateId:id}),result:modelRouteDraft},
  "models.reviewPrimary": {params:shape({windowId:id,generation:integer(1),route:candidateRoute},{candidateId:id}),result:modelRouteDraft},
  "models.applyDraft": {params:modelDraftBinding,result:modelApplyReceipt},
 'settings.workspaces':{params:shape({}),result:shape({items:array(shape({id,alias:text(64,1),path:text(4096,1),trusted:boolean,revision:integer(1)}),100),truncated:boolean})},
 'settings.reviewAction':{params:settingsAction,result:shape({reviewId:id,action:settingsAction,facts:array(text(4096),8),expiresAt:integer(1)})},
 'settings.executeAction':{params:shape({reviewId:id,operationId:id,confirmed:v=>v===true}),result:connectionOperation},
 'settings.cancelAction':{params:shape({reviewId:id}),result:shape({cancelled:boolean})},
 'media.stage':{params:shape({path:text(4096,1),target}),result:shape({id,name:text(200,1),size:integer(1,8388608),type:text(80,1)})},
 'artifacts.mediaBegin':{params:shape({reference:artifactReference}),result:shape({transferId:id,bytes:integer(1,8388608),mimeType:text(80,1),sha256:text(64,64),name:text(200,1)})},
 'artifacts.mediaChunk':{params:shape({transferId:id,offset:integer(0,8388608)}),result:shape({data:text(32768)})},
 'artifacts.mediaClose':{params:shape({transferId:id}),result:shape({closed:boolean})},
  "settings.apply": {params:settingsBinding,result:shape({operationId:id,state:choice(['applied','uncertain','unknown'])})},
  "settings.inspect":{params:shape({},{operationId:id}),result:shape({operationId:id,state:choice(['applied','uncertain','unknown'])})},
  "settings.verify":{params:shape({}),result:shape({state:choice(['configured','repair_required'])})},
  "settings.value":{params:shape({fieldId:text(240,1),selectors:array(text(128,1),8)}),result:settingChange},
  'schedules.draft':{params:shape({id}),result:scheduleDraft},
 'schedules.review':{params:scheduleAction,result:scheduleReview},
 'schedules.cancel':{params:shape({reviewId:id}),result:shape({cancelled:boolean})},
 'schedules.execute':{params:shape({reviewId:id,operationId:id,confirmed:(v)=>v===true}),result:connectionOperation},
 'schedules.inspect':{params:shape({operationId:id}),result:connectionOperation},
 'schedules.list':{params:shape({},{offset:integer(0,1000)}),result:shape({items:array(scheduleProjection,50),nextOffset:nullable(integer(0,1000))})},
 'schedules.get':{params:shape({id}),result:scheduleProjection},
 'schedules.history':{params:shape({id},{offset:integer(0,Number.MAX_SAFE_INTEGER)}),result:shape({items:array(scheduleExecution,50),nextOffset:nullable(integer(0,Number.MAX_SAFE_INTEGER)),available:boolean})},
 'evolution.review':{params:shape({proposalId:id,action:choice(['test','approve','reject','promote','rollback'])},{target}),result:shape({reviewId:id,proposalId:id,action:choice(['test','approve','reject','promote','rollback']),diff:text(8192),commands:array(text(240),16),workspace:nullable(text(2048)),allowed:boolean,reason:choice(['ready','stale','gates_failed','workspace_required','unsupported','review_too_large','approval_required'])})},
  'evolution.cancel':{params:shape({reviewId:id}),result:shape({cancelled:boolean})},
  'evolution.execute':{params:shape({reviewId:id,operationId:id,confirmed:(v)=>v===true}),result:connectionOperation},
  'evolution.inspect':{params:shape({operationId:id}),result:connectionOperation},
  'library.proposals':{params:shape({},{offset:integer(0,Number.MAX_SAFE_INTEGER)}),result:shape({items:array(libraryProposal,50),nextOffset:nullable(integer(0,Number.MAX_SAFE_INTEGER))})},
  'library.proposal':{params:shape({id}),result:shape({proposal:libraryProposal,diff:text(8192),gate:libraryGate,evidence:array(shape({id,summary:text(2048),sourceWorkId:nullable(id)}),50),evalRuns:array(shape({id,label:text(240),passed:boolean}),20),manifest:nullable(shape({id,status:text(80),target:text(80),commands:array(text(240),16)})),promotions:array(shape({id,appliedAt:text(80),snapshotAvailable:boolean}),20),rollbackAvailable:boolean,truncated:boolean})},
  'library.skills':{params:shape({},{offset:integer(0,1000)}),result:shape({items:array(librarySkill,50),nextOffset:nullable(integer(0,1000))})},
  'library.skill':{params:shape({id}),result:shape({skill:librarySkill,instructions:text(16384),truncated:boolean})},
  'library.memory':{params:shape({}),result:shape({items:array(shape({kind:choice(['USER.md','SOUL.md','MEMORY.md']),scope:choice(['profile']),content:text(16384),truncated:boolean}),3)})},
  'setup.verify':{params:shape({},{alias:text(64,1)}),result:shape({detection:shape({state:choice(SETUP_STATES),mode:choice(['first-run','repair','ready']),writable:boolean,launchReady:boolean,pendingApply:boolean}),workspace:nullable(text(64,1)),target:nullable(target)})},
  'setup.review':{params:shape({model:modelDraftBinding,preferences:array(settingChange,4),workspaceReviewId:id},{optional:settingsBinding}),result:shape({reviewId:id,route:modelRouteDraft,changes:array(settingChange,36),workspace:shape({reviewId:id,path:text(4096,1),alias:text(64,1),trust:boolean})})},
  'setup.apply':{params:shape({reviewId:id,confirmed:v=>v===true}),result:shape({operationId:id,state:choice(['applied','uncertain','unknown'])})},
  'setup.recover':{params:shape({}),result:shape({operationId:id,state:choice(['applied','uncertain','unknown'])})},
  'setup.reviewWorkspace':{params:shape({path:text(4096,1),alias:text(64,1),trust:boolean}),result:shape({reviewId:id,path:text(4096,1),alias:text(64,1),trust:boolean})},
  'setup.applyWorkspace':{params:shape({reviewId:id,operationId:id,confirmed:v=>v===true}),result:connectionOperation},
  'setup.cancelWorkspace':{params:shape({reviewId:id}),result:shape({cancelled:boolean})},
  "setup.local":{params:shape({}),result:shape({profileId:id,configuration:shape({state:choice(SETUP_STATES),mode:choice(["first-run","repair","ready"]),writable:boolean,launchReady:boolean,pendingApply:boolean}),runtime:choice(["stopped","starting","ready","disconnected","incompatible","unavailable"]),compatibility:choice(["compatible","incompatible","unavailable"]),canConnect:boolean})},
  "setup.detect":{params:shape({}),result:shape({state:choice(SETUP_STATES),mode:choice(["first-run","repair","ready"]),writable:boolean,launchReady:boolean,pendingApply:boolean})},
  "setup.bootstrap":{params:shape({}),result:shape({state:choice(SETUP_STATES),mode:choice(["first-run","repair","ready"]),writable:boolean,launchReady:boolean,pendingApply:boolean})},
  "settings.lifecycle":{params:shape({}),result:shape({version:text(64,1),owner:text(64,1),update:choice(["owner_required"]),uninstall:choice(["owner_required"])})},
  "settings.dependencies":{params:shape({}),result:shape({items:array(shape({id,version:text(64,1),packages:array(text(240,1),64),groups:array(id,8),estimatedMb:nullable(integer()),state:choice(['installed','install_required','repair_required'])},{available:boolean}),32)})},
  "settings.installDependency":{params:shape({operationId:id,capabilityId:id,groups:unique(id,8),downloadApproved:v=>v===true}),result:connectionOperation},
  "settings.inspectDependency":{params:shape({operationId:id}),result:connectionOperation},
  "settings.read":{params:shape({section:choice(SETTINGS_SECTIONS)},{offset:integer(0,10000)}),result:shape({fields:array(settingField,100),values:array(settingChange,100),truncated:boolean},{nextOffset:integer(0,10000),runtime:shape({effective:array(settingChange,100),defaults:array(settingChange,100)}),web:shape({effective:array(settingChange,100),defaults:array(settingChange,100)},{searchProviders:array(shape({id,label:text(240,1),implemented:boolean,available:boolean}),100),resolvedSearch:nullable(id)}),media:shape({effective:array(settingChange,100),defaults:array(settingChange,100)},{analysis:nullable(shape({providerId:id,modelId:text(200,1)})),imageModels:array(shape({providerId:id,id:text(200,1),label:text(240,1)}),100)})})},
  "settings.review":{params:shape({windowId:id,generation:integer(1),changes:array(settingChange,32,1)}),result:shape({draftId:id,changes:array(settingChange,32,1),previous:array(settingChange,32),expiresInMs:integer(1,300000)})},
  "settings.cancel":{params:settingsBinding,result:shape({cancelled:boolean})},
  "models.cancelDraft": {params:modelDraftBinding,result:shape({cancelled:boolean})},
  "models.inspectApply": {params:shape({},{operationId:id}),result:modelApplyReceipt},
  "models.verifyCandidate": {params:shape({windowId:id,generation:integer(1),spendApproved:v=>v===true,route:candidateRoute},{candidateId:id}),result:candidateVerification},
  "connections.inspectOperation":{params:shape({operationId:id}),result:shape({operationId:id,action:text(80,1),state:choice(['completed','failed','uncertain','unknown'])},{issue:choice(CONNECTION_OPERATION_ISSUES),phase:choice(['preparing','installing','verifying'])})},
  "gateway.execute":{params:shape({operationId:id,action:choice(['install','start','stop','restart','update']),acknowledgeSharedWork:(value)=>value===true}),result:shape({operationId:id,action:text(80,1),state:choice(['completed','failed','uncertain','unknown'])},{issue:choice(CONNECTION_OPERATION_ISSUES),phase:choice(['preparing','installing','verifying'])})},
  "gateway.diagnostics":{params:shape({}),result:shape({queuedTurns:nullable(integer()),uncertainTurns:nullable(integer()),recentDeliveryFailures:nullable(integer()),service:choice(['installed','absent','unknown']),manager:choice(['launchd','systemd-user','systemd-system','none']),runtime:choice(['running','stopped','disconnected']),polling:choice(['unknown','starting','healthy','degraded','stopped']),observedAt:nullable(integer())},{build:choice(['current','different','unknown']),updateAvailable:boolean})},
  "telegram.execute":{params:shape({operationId:id,action:choice(['pairingCreate','pairingCancel','sync','test']),confirmed:v=>v===true},{destination:text(21,1)}),result:shape({operationId:id,action:text(80,1),state:choice(['completed','failed','uncertain','unknown'])},{issue:choice(CONNECTION_OPERATION_ISSUES),phase:choice(['preparing','installing','verifying'])})},
  "telegram.pairing":{params:shape({}),result:shape({code:nullable(text(64,4)),expiresAt:nullable(integer())})},
  "telegram.sessions":{params:shape({}),result:shape({items:array(shape({sessionId:id,workId:id,title:text(240),attached:boolean}),100),truncated:boolean})},
  "telegram.sessionDetails":{params:shape({sessionId:id}),result:shape({codes:array(shape({code:text(64,4),expiresAt:integer()}),10),attachments:array(shape({id:text(512,1),attachedAt:integer()}),100)})},
  "telegram.handoff":{params:shape({operationId:id,sessionId:id,action:choice(['create','revoke','detach']),confirmed:v=>v===true},{attachmentId:text(512,1)}),result:shape({operationId:id,action:text(80,1),state:choice(['completed','failed','uncertain','unknown'])},{issue:choice(CONNECTION_OPERATION_ISSUES),phase:choice(['preparing','installing','verifying'])})},
  "telegram.verify":{params:shape({windowId:id,generation:integer(1)},{candidateId:id}),result:shape({state:choice(['passed','failed']),reason:choice(['none','credential_missing','invalid_credential','invalid_response','unavailable','cancelled']),verifiedAt:nullable(integer()),botUsername:nullable(text(64,1)),latencyMs:integer()})},
  "telegram.settings":{params:shape({}),result:telegramSettings},
  "telegram.review":{params:shape({windowId:id,generation:integer(1),settings:telegramSettings},{candidateId:id}),result:shape({draftId:id,expiresInMs:integer(1),settings:telegramSettings,credentialState:choice(['staged','existing','missing'])})},
  "telegram.apply":{params:shape({draftId:id,windowId:id,generation:integer(1)}),result:shape({operationId:id,state:choice(['applied','uncertain','unknown']),verification:choice(['configured','repair_required','not_tested'])})},
  "telegram.cancel":{params:shape({draftId:id,windowId:id,generation:integer(1)}),result:shape({cancelled:boolean})},
  "telegram.inspectApply":{params:shape({},{operationId:id}),result:shape({operationId:id,state:choice(['applied','uncertain','unknown']),verification:choice(['configured','repair_required','not_tested'])})},
  "models.verifyDraft": {params:shape({draftId:id,windowId:id,generation:integer(1),spendApproved:v=>v===true,allowPrivateEndpoint:boolean}),result:candidateVerification},
  "models.list": { params: shape(pageParams, optionalPage), result: page(model) },
  "providers.list": { params: shape(pageParams, optionalPage), result: page(provider) },
  "connections.list": { params: shape(pageParams, optionalPage), result: page(connection) },
  "connections.get": { params: shape({ connectionId: id }), result: connection },
  "tasks.create": {params:shape({...sessionParams,taskId:id,objective:text(4000,1),limits:shape({maxProviderCalls:integer(1,45),maxTotalTokens:integer(1,1000000),maxWallClockMs:integer(1,1800000)}),selection:nullable(shape({providerId:id,modelId:text(200,1)}))}),result:receipt},
  "tasks.pause": { params: shape({ ...sessionParams, taskId: id }), result: receipt },
  "tasks.resume": { params: shape({ ...sessionParams, taskId: id }), result: receipt },
  "tasks.cancel": { params: shape({ ...sessionParams, taskId: id }), result: receipt },
  "tasks.retry": { params: shape({ ...sessionParams, taskId: id }, { stepId: id }), result: receipt },
  "tasks.guide": { params: shape({ ...sessionParams, taskId: id, guidance: text(4000, 1) }), result: receipt },
  "sessions.start": { params: shape(sessionParams), result: receipt },
  "sessions.resume": { params: shape(sessionParams), result: receipt },
  "sessions.send": { params: shape({ ...sessionParams, text: text(32_768, 1) },{mediaIds:unique(id,4),securityMode:choice(["strict","adaptive","open"]),interrupt:boolean}), result: receipt },
  "sessions.cancelTurn": { params: shape(sessionParams), result: receipt },
  "approvals.resolve": { params: shape({ ...sessionParams, approvalId: id, decision: choice(["approved", "denied"]) }), result: receipt },
  "operations.inspect": { params: shape({ ...sessionParams, method: choice(mutationMethods) }, { taskId: id }), result: receipt },
};
/** Established by the trusted connection, never populated from request authority fields. */
export type ControlContext = { profileId: string; instanceId: string; capabilities: Capabilities };
function contextValid(context: ControlContext): boolean { return id(context.profileId) && id(context.instanceId) && capabilities(context.capabilities); }
function subset(actual: Capabilities, allowed: Capabilities): boolean {
  return actual.methods.every((name) => allowed.methods.includes(name)) && actual.events.every((name) => allowed.events.includes(name));
}
export function validateControlRequest(value: unknown, context: ControlContext | null): MethodRequest {
  assertEnvelope(value);
  if (!("method" in value) || !("id" in value)) throw new ControlProtocolError("-32600");
  if (!Object.hasOwn(contracts, value.method)) throw new ControlProtocolError("-32601");
  const method = value.method as keyof MethodContracts;
  if (!contracts[method].params(value.params)) throw new ControlProtocolError("-32602");
  if (method === "operations.inspect" && isRecord(value.params) &&
    (String(value.params.method).startsWith("tasks.") ? !id(value.params.taskId) : value.params.taskId !== undefined)) throw new ControlProtocolError("-32602");
  if (method === "control.initialize") {
    if (context !== null) throw new ControlProtocolError("-32600");
  } else {
    if (!context) throw new ControlProtocolError("-32002");
    if (!contextValid(context)) throw new ControlProtocolError("-32003");
    if (!context.capabilities.methods.includes(method)) throw new ControlProtocolError("-32601");
    if (method === "control.subscribe") {
      const params = value.params as unknown as MethodContracts["control.subscribe"]["params"];
      if (params.after.instanceId !== context.instanceId) throw new ControlProtocolError("-32007");
      if (!params.events.every((event) => context.capabilities.events.includes(event))) throw new ControlProtocolError("-32601");
    }
    if (method === "control.cancelRequest" && value.params.requestId === value.id) throw new ControlProtocolError("-32602");
  }
  return value as MethodRequest;
}
function scoped(value: unknown, profileId: string): boolean {
  return !isRecord(value) || (!Object.hasOwn(value, "profileId") || value.profileId === profileId);
}
/** Correlation requires the original request, not a method string guessed from the response. */
export function validateControlResponse<M extends keyof MethodContracts>(value: unknown, request: MethodRequest<M>, context: ControlContext | null): MethodSuccess<M> | RpcFailure {
  validateControlRequest(request, context);
  assertEnvelope(value);
  if (!("id" in value) || "method" in value || value.id !== request.id) throw new ControlProtocolError("-32600");
  if ("error" in value) return value;
  if (!contracts[request.method].result(value.result)) throw new ControlProtocolError("-32602");
  if (request.method === "control.initialize") {
    const result = value.result as unknown as MethodContracts["control.initialize"]["result"];
    const params = request.params as MethodContracts["control.initialize"]["params"];
    if (result.profileId !== params.profileId || result.protocolVersion.major !== DESKTOP_PROTOCOL_VERSION.major ||
      result.protocolVersion.major !== params.protocolVersion.major || result.protocolVersion.minor > Math.min(params.protocolVersion.minor, DESKTOP_PROTOCOL_VERSION.minor) ||
      !result.capabilities.methods.every((name) => params.capabilities.methods.includes(name)) ||
      !result.capabilities.events.every((name) => params.capabilities.events.includes(name))) throw new ControlProtocolError("-32003");
  } else {
    const result = value.result as Record<string, unknown>;
    if (!scoped(result, context!.profileId) || (Array.isArray(result.items) && !result.items.every((item) => scoped(item, context!.profileId)))) throw new ControlProtocolError("-32003");
    if(request.method==="models.oauthStatus" && result.authorizationId!==(request.params as MethodContracts["models.oauthStatus"]["params"]).authorizationId)throw new ControlProtocolError("-32003");
    if ("limit" in request.params && Array.isArray(result.items) && result.items.length > request.params.limit) throw new ControlProtocolError("-32009");
    if(request.method==='inbox.get'&&result.id!==request.params.itemId)throw new ControlProtocolError('-32003');
    if (request.method === "work.get" && result.id !== request.params.workId) throw new ControlProtocolError("-32003");
    if (request.method === "connections.get" && result.id !== request.params.connectionId) throw new ControlProtocolError("-32003");
    if (request.method === "work.activity" && !(result.items as { workId: string }[]).every((item) => item.workId === request.params.workId)) throw new ControlProtocolError("-32003");
    if (request.method === "control.bootstrap") {
      const boot = value.result as unknown as MethodContracts["control.bootstrap"]["result"];
      if (boot.profile.id !== context!.profileId || boot.cursor.instanceId !== context!.instanceId || !subset(boot.capabilities, context!.capabilities)) throw new ControlProtocolError("-32003");
    }
    if (request.method === "control.subscribe" && result.state === "subscribed") {
      const cursor = (result as unknown as { cursor: MethodContracts["control.subscribe"]["params"]["after"] }).cursor;
      // The snapshot cursor covers the negotiated event set, not a filtered subsequence.
      if (!context!.capabilities.events.every((event) => request.params.events.includes(event)) ||
        cursor.instanceId !== context!.instanceId || cursor.streamId !== request.params.after.streamId || cursor.sequence !== request.params.after.sequence) throw new ControlProtocolError("-32007");
    }
    if(request.method==='models.reviewConfigured' && (result.role!==request.params.role || result.slot!==request.params.slot || (result.route as CandidateRoute).providerId!==request.params.providerId || (result.route as CandidateRoute).modelId!==request.params.modelId))throw new ControlProtocolError('-32003');
    const expectedRole:Record<string,string>={'models.reviewProvider':'provider','models.reviewPrimary':'primary','models.reviewFallback':'fallback','models.reviewFallbackOrder':'fallback_order','models.reviewAuxiliary':'auxiliary','models.reviewAuxiliaryMode':'auxiliary_mode'};
    const requiredRole=expectedRole[request.method];
    if(requiredRole && result.role!==requiredRole)throw new ControlProtocolError('-32003');
    if ((request.method==='models.reviewAuxiliary'||request.method==='models.reviewAuxiliaryMode') && result.slot!==request.params.slot)throw new ControlProtocolError('-32003');
    if (request.method === 'models.inspectApply' && request.params.operationId!==undefined && result.operationId !== request.params.operationId) throw new ControlProtocolError('-32003');
    if (request.method === 'models.applyDraft' && result.operationId !== request.params.draftId) throw new ControlProtocolError('-32003');
    if ((request.method === 'models.reviewProvider' || request.method === 'models.reviewPrimary' || request.method === 'models.reviewFallback' || request.method === 'models.reviewAuxiliary') && candidateRouteBinding(result.route as CandidateRoute) !== candidateRouteBinding(request.params.route)) throw new ControlProtocolError('-32003');
    if ("operationId" in request.params && 'sessionId' in request.params && 'target' in request.params) {
      const receipt = value.result as unknown as OperationReceipt;
      const method = request.method === "operations.inspect" ? request.params.method : request.method;
      if (receipt.operationId !== request.params.operationId || receipt.sessionId !== request.params.sessionId || receipt.method !== method ||
        (receipt.taskId !== ("taskId" in request.params ? request.params.taskId : undefined)) ||
        receipt.target.targetId !== request.params.target.targetId || receipt.target.targetGeneration !== request.params.target.targetGeneration) throw new ControlProtocolError("-32003");
    }
  }
  return value as unknown as MethodSuccess<M>;
}
const eventPayloads: { [E in ControlEvent["type"]]: Check } = {
  "control.ready": shape({ state: choice(["ready"]) }), "work.changed": work, "activity.appended": activity,
  "attention.changed": (v) => shape({ item: nullable(inbox), itemId: id })(v) && isRecord(v) && (v.item === null || (v.item as { id: string }).id === v.itemId),
  "modelRoute.changed": model, "connection.changed": connection,
  "service.warning": shape({ reason: choice(["resync_required", "runtime_unavailable", "configuration_changed"]) }),
  "service.shutdown": shape({ reason: choice(["client_closed", "profile_changed", "service_restart"]) }),
};
export type SubscriptionContext = { subscriptionId: string; streamId: string; events: ControlEventType[] };
export function validateEventNotification(value: unknown, context: ControlContext, subscription: SubscriptionContext): EventNotification {
  assertEnvelope(value);
  if (!contextValid(context)) throw new ControlProtocolError("-32003");
  if (!("method" in value) || "id" in value || value.method !== "control.event") throw new ControlProtocolError("-32600");
  const event = value.params;
  if (!shape({ profileId: id, subscriptionId: id, cursor: isControlCursor, timestamp: integer(), type: choice(CONTROL_EVENTS), payload: () => true })(event) ||
    !eventPayloads[event.type as ControlEvent["type"]](event.payload)) throw new ControlProtocolError("-32602");
  const typed = event as unknown as ControlEvent;
  if (typed.profileId !== context.profileId || typed.cursor.instanceId !== context.instanceId || typed.subscriptionId !== subscription.subscriptionId ||
    typed.cursor.streamId !== subscription.streamId || !context.capabilities.events.includes(typed.type) || !subscription.events.includes(typed.type) ||
    !scoped(typed.payload, context.profileId) || (typed.type === "attention.changed" && !scoped(typed.payload.item, context.profileId))) throw new ControlProtocolError("-32003");
  return value as unknown as EventNotification;
}
