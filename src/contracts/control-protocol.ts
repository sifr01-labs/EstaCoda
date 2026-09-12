import {validateHumanBrowserCommand,type HumanBrowserCommand} from './desktop-control/browser-human.js';
/** Existing shared-host v1 semantics. Pure contract only: no transport or authority. */
export const PRIVATE_CONTROL_MAX_BYTES = 131_072;
export type PrivateControlRequest = {
  browserControl?:HumanBrowserCommand;
  method: "browser.control" | "task.create" | "model" | "task.model" | "send" | "cancel" | "approval" | "inspect" | "start" | "resume" | "task.pause" | "task.resume" | "task.cancel" | "task.retry" | "task.guide";
  sessionId: string; targetId: string; operationId: string;
  objective?:string; limits?:{maxProviderCalls:number;maxTotalTokens:number;maxWallClockMs:number};
  selection?: {providerId:string;modelId:string}|null;
  taskId?: string; stepId?: string; guidance?: string;
  targetGeneration?: number;
  text?: string; approvalId?: string; decision?: "approved" | "denied";
};

export function validatePrivateControlRequest(value: unknown): asserts value is PrivateControlRequest {
  if (!value || typeof value !== "object") throw new Error("Invalid control request.");
  const request = value as PrivateControlRequest;
  if(request.method==='browser.control'){
    validateHumanBrowserCommand(request.browserControl);
    if(request.targetGeneration===undefined||Object.keys(request).sort().join(',')!=='browserControl,method,operationId,sessionId,targetGeneration,targetId')throw new Error('Invalid browser owner binding.');
  }
  if(request.method==='task.create'&&(typeof request.objective!=='string'||!request.objective.trim()||request.objective.length>4000||!request.limits||Object.keys(request.limits).length!==3||!Object.keys(request.limits).every(key=>['maxProviderCalls','maxTotalTokens','maxWallClockMs'].includes(key))||!Object.entries({maxProviderCalls:45,maxTotalTokens:1_000_000,maxWallClockMs:1_800_000}).every(([key,max])=>{const value=request.limits![key as keyof NonNullable<PrivateControlRequest['limits']>];return Number.isSafeInteger(value)&&value>=1&&value<=max;})))throw new Error('Invalid Task creation.');
  if (!["browser.control","task.create", "model", "task.model", "send", "cancel", "approval", "inspect", "start", "resume", "task.pause", "task.resume", "task.cancel", "task.retry", "task.guide"].includes(request.method) ||
    ((request.method === "model" || request.method === "task.model" || request.method === "task.create") && (request.targetGeneration === undefined || request.selection !== null && (!request.selection || typeof request.selection.providerId !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(request.selection.providerId) || typeof request.selection.modelId !== "string" || request.selection.modelId.length < 1 || request.selection.modelId.length > 200))) ||
    [request.sessionId, request.targetId, request.operationId].some((id) => typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(id)) ||
    (request.method.startsWith("task.") && (typeof request.taskId !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(request.taskId) || request.targetGeneration === undefined)) ||
    (request.stepId !== undefined && !/^[A-Za-z0-9_.:-]{1,160}$/.test(request.stepId)) ||
    (request.method === "task.guide" && (typeof request.guidance !== "string" || request.guidance.length < 1 || request.guidance.length > 4000)) ||
    (request.targetGeneration !== undefined && (!Number.isSafeInteger(request.targetGeneration) || request.targetGeneration < 1)) ||
    (request.method === "send" && (typeof request.text !== "string" || request.text.length < 1 || request.text.length > 32_768)) ||
    (request.method === "approval" && (typeof request.approvalId !== "string" || request.approvalId.length > 160 || !["approved", "denied"].includes(request.decision ?? "")))) {
    throw new Error("Invalid control request.");
  }
}
