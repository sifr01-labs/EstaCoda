import type {Draft} from './app.js';
import {emptyDraft} from './app.js';
import type {SavedDraft} from '../shared/chat-presentation.js';
/** Attachments and reviewed execution limits expire; restore text and target references only. */
export function saveDrafts(drafts:Record<string,Draft>):Record<string,SavedDraft>{
 return Object.fromEntries(Object.entries(drafts).filter(([key,d])=>key==='welcome'||key.startsWith('draft-')||!!(d.text||d.queued)).map(([key,d])=>[key,{id:d.id??crypto.randomUUID(),text:[d.queued?.text,d.text].filter(Boolean).join('\n\n'),model:d.model,...(d.targetLabel?{targetLabel:d.targetLabel}:{}),...(d.kind?{kind:d.kind}:{}),...(d.target?{target:d.target}:{}),...(d.modelSelection!==undefined?{modelSelection:d.modelSelection}:{})}]));
}
export function restoreDrafts(drafts:Record<string,SavedDraft>):Record<string,Draft>{return Object.fromEntries(Object.entries(drafts).filter(([key,d])=>key==='welcome'||key.startsWith('draft-')||!!d.text).map(([key,d])=>[key,{...emptyDraft(),...d}]));}
