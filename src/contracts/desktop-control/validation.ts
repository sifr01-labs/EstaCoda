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
const capabilities = shape({ methods: unique(choice(CONTROL_METHODS),128), events: unique(choice(CONTROL_EVENTS)) });
const target = shape({ targetId: id, targetGeneration: integer(1) });
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
  message: shape({ ...activityBase, kind: choice(["message"]), role: choice(["user", "assistant"]), text: text(16_384) }),
  assistant_delta: shape({ ...activityBase, kind: choice(["assistant_delta"]), text: text(4_096, 1) }),
  tool: shape({ ...activityBase, kind: choice(["tool"]), name: text(160, 1), state: choice(["running", "completed", "failed", "cancelled"]), summary: text(2_048) }),
  plan: shape({ ...activityBase, kind: choice(["plan"]), steps: array(shape({ id, title: text(240, 1), status: choice(["pending", "running", "completed", "failed"]) }), 64) }),
  result: shape({ ...activityBase, kind: choice(["result"]), status: choice(WORK_STATUSES), evidence, usage }),
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
 telegram:shape({status:choice(["disabled","credential_missing","authorization_missing","pairing_pending","ready"]),allowedUsers:integer(0,1000),allowedChats:integer(0,1000),pairingExpiresAt:nullable(integer()),polling:choice(["unknown","starting","healthy","degraded","stopped"]),observedAt:nullable(integer()),lastVerifiedAt:nullable(integer())}) });
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
const modelRouteDraftShape=shape({draftId:id,expiresInMs:integer(1,900000),credentialState:choice(['staged','existing','not_required']),role:choice(['primary','fallback','fallback_order','auxiliary','auxiliary_mode'])},{route:candidateRoute,slot:choice(AUXILIARY_SLOTS)});
const modelRouteDraft:Check=v=>modelRouteDraftShape(v)&&isRecord(v)&&(['fallback_order','auxiliary_mode'].includes(String(v.role))?v.route===undefined:candidateRoute(v.route))&&(['auxiliary','auxiliary_mode'].includes(String(v.role))?choice(AUXILIARY_SLOTS)(v.slot):v.slot===undefined);
const modelDraftBinding=shape({draftId:id,windowId:id,generation:integer(1)});
const modelApplyReceipt=shape({operationId:id,state:choice(['applied','uncertain','unknown']),verification:choice(['configured','repair_required','not_tested'])});
const oauthBinding=shape({authorizationId:id,windowId:id,generation:integer(1)});
const oauthStatusShape=shape({authorizationId:id,state:choice(['starting','pending','authorized','failed','cancelled','expired']),verificationUrl:nullable(choice(['https://auth.openai.com/codex/device'])),userCode:nullable((v)=>typeof v==='string' && /^[-A-Z0-9]{1,32}$/i.test(v)),candidateId:nullable(id)});
const oauthStatus:Check=v=>oauthStatusShape(v)&&isRecord(v)&&(v.state==='pending'?v.verificationUrl!==null&&v.userCode!==null:v.verificationUrl===null&&v.userCode===null)&&(v.state==='authorized'?v.candidateId!==null:v.candidateId===null);
const candidateVerification=shape({state:choice(['passed','failed','cancelled']),reason:choice(['none','unreachable','invalid_credential','model_unavailable','unsupported','incomplete','cancelled']),streaming:boolean,tools:boolean,latencyMs:integer(),inputTokens:nullable(integer()),outputTokens:nullable(integer()),estimatedCost:nullable(nonnegative)});
const contracts: { [M in keyof MethodContracts]: { params: Check; result: Check } } = {
  "models.reviewConfigured": {params:shape({windowId:id,generation:integer(1),providerId:id,modelId:text(200,1),role:choice(["primary","fallback","auxiliary"])},{slot:choice(AUXILIARY_SLOTS),fallbackToMain:boolean}),result:modelRouteDraft},
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
  "work.targets": {params:shape({}),result:shape({items:array(targetProjection),truncated:boolean})},
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
  "models.reviewPrimary": {params:shape({windowId:id,generation:integer(1),route:candidateRoute},{candidateId:id}),result:modelRouteDraft},
  "models.applyDraft": {params:modelDraftBinding,result:modelApplyReceipt},
  "models.cancelDraft": {params:modelDraftBinding,result:shape({cancelled:boolean})},
  "models.inspectApply": {params:shape({},{operationId:id}),result:modelApplyReceipt},
  "models.verifyCandidate": {params:shape({windowId:id,generation:integer(1),spendApproved:v=>v===true,route:candidateRoute},{candidateId:id}),result:candidateVerification},
  "connections.inspectOperation":{params:shape({operationId:id}),result:shape({operationId:id,action:text(80,1),state:choice(['completed','failed','uncertain','unknown'])})},
  "gateway.execute":{params:shape({operationId:id,action:choice(['install','start','stop','restart']),acknowledgeSharedWork:(value)=>value===true}),result:shape({operationId:id,action:text(80,1),state:choice(['completed','failed','uncertain','unknown'])})},
  "gateway.diagnostics":{params:shape({}),result:shape({queuedTurns:nullable(integer()),uncertainTurns:nullable(integer()),recentDeliveryFailures:nullable(integer()),service:choice(['installed','absent','unknown']),manager:choice(['launchd','systemd-user','systemd-system','none']),runtime:choice(['running','stopped','disconnected']),polling:choice(['unknown','starting','healthy','degraded','stopped']),observedAt:nullable(integer())})},
  "telegram.execute":{params:shape({operationId:id,action:choice(['pairingCreate','pairingCancel','sync','test']),confirmed:v=>v===true},{destination:text(21,1)}),result:shape({operationId:id,action:text(80,1),state:choice(['completed','failed','uncertain','unknown'])})},
  "telegram.pairing":{params:shape({}),result:shape({code:nullable(text(64,4)),expiresAt:nullable(integer())})},
  "telegram.sessions":{params:shape({}),result:shape({items:array(shape({sessionId:id,workId:id,title:text(240),attached:boolean}),100),truncated:boolean})},
  "telegram.sessionDetails":{params:shape({sessionId:id}),result:shape({codes:array(shape({code:text(64,4),expiresAt:integer()}),10),attachments:array(shape({id:text(512,1),attachedAt:integer()}),100)})},
  "telegram.handoff":{params:shape({operationId:id,sessionId:id,action:choice(['create','revoke','detach']),confirmed:v=>v===true},{attachmentId:text(512,1)}),result:shape({operationId:id,action:text(80,1),state:choice(['completed','failed','uncertain','unknown'])})},
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
  "sessions.send": { params: shape({ ...sessionParams, text: text(32_768, 1) }), result: receipt },
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
    const expectedRole:Record<string,string>={'models.reviewPrimary':'primary','models.reviewFallback':'fallback','models.reviewFallbackOrder':'fallback_order','models.reviewAuxiliary':'auxiliary','models.reviewAuxiliaryMode':'auxiliary_mode'};
    const requiredRole=expectedRole[request.method];
    if(requiredRole && result.role!==requiredRole)throw new ControlProtocolError('-32003');
    if ((request.method==='models.reviewAuxiliary'||request.method==='models.reviewAuxiliaryMode') && result.slot!==request.params.slot)throw new ControlProtocolError('-32003');
    if (request.method === 'models.inspectApply' && request.params.operationId!==undefined && result.operationId !== request.params.operationId) throw new ControlProtocolError('-32003');
    if (request.method === 'models.applyDraft' && result.operationId !== request.params.draftId) throw new ControlProtocolError('-32003');
    if ((request.method === 'models.reviewPrimary' || request.method === 'models.reviewFallback' || request.method === 'models.reviewAuxiliary') && candidateRouteBinding(result.route as CandidateRoute) !== candidateRouteBinding(request.params.route)) throw new ControlProtocolError('-32003');
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
