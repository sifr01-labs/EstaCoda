import type {MessageKey} from './index.js';
/** Stable attention IDs are presentation codes, never authorization handles. */
export const attentionCopy:Readonly<Record<string,readonly [MessageKey,MessageKey]>>={
 "setup:model": [
  "Choose a model",
  "Configure a model route before starting Work."
 ],
 "setup:credential": [
  "Review provider credentials",
  "The selected route requires a credential or provider authorization."
 ],
 "setup:authorization": [
  "Provider authorization expired",
  "Review the provider connection before continuing."
 ],
 "setup:repair": [
  "Review profile setup",
  "Saved provider or profile state needs repair."
 ],
 "setup:schedules": [
  "Review schedules",
  "Saved schedule state needs repair."
 ],
 "setup:evolution": [
  "Review Agent Evolution state",
  "Saved proposal state needs repair."
 ],
 "setup:supervisor": [
  "Shared execution needs attention",
  "Review the shared supervisor connection before continuing."
 ]
};
