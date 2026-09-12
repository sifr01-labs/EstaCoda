import type {TargetReference} from './projections.js';
/** Historical observation handle, never a browser-control capability. */
export type BrowserViewReference={sessionId:string;browserId:string;eventId:number;target:TargetReference};
export type BrowserViewState={reference:BrowserViewReference;url:string|null;title:string|null;observedAt:string;readiness:'loading'|'interactive'|'complete'|'unknown';state:'recorded'|'blocked';lastAction:string;artifacts:import('./artifacts.js').ArtifactReference[]};
