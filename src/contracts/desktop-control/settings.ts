/** Public, bounded presentation metadata. No paths to profile files or raw credentials. */
export type SettingValue=string|number|boolean|string[]|null;
export type SettingsSection='models'|'vision'|'voice'|'browser'|'runtime'|'governance'|'channels'|'capabilities';
export const SETTINGS_SECTIONS:readonly SettingsSection[]=['models','vision','voice','browser','runtime','governance','channels','capabilities'];
export type SettingField={id:string;section:SettingsSection;path:string[];kind:'scalar'|'text'|'number'|'boolean'|'choice'|'strings'|'secret';choices?:Array<string|number|boolean>;min?:number;max?:number;envName?:string};
export type SettingChange={fieldId:string;selectors:string[];value:SettingValue};
export type SettingsPage={fields:SettingField[];values:SettingChange[];truncated:boolean;nextOffset?:number;media?:MediaSettingsMetadata;web?:WebSettingsMetadata;runtime?:RuntimeSettingsMetadata};
export type SettingsReview={draftId:string;changes:SettingChange[];previous:SettingChange[];expiresInMs:number};
export type SettingsBinding={draftId:string;windowId:string;generation:number};

export type SettingsDependenciesPage={items:Array<{id:string;version:string;packages:string[];groups:string[];estimatedMb:number|null;state:'installed'|'install_required'|'repair_required';available?:boolean}>};

export const SETTINGS_ACTIONS=['pack.install','pack.enable','pack.disable','pack.remove','profile.create','profile.copy','profile.default','profile.rename','profile.delete','workspace.add','workspace.rename','workspace.move','workspace.remove','workspace.trust','workspace.revoke'] as const;
export type SettingsAction={action:typeof SETTINGS_ACTIONS[number];subject:string;value:string};
export type SettingsActionReview={reviewId:string;action:SettingsAction;facts:string[];expiresAt:number};
export type SettingsWorkspace={id:string;alias:string;path:string;trusted:boolean;revision:number};

/** Safe, offline media defaults. Credential values are presence markers only. */
export type MediaSettingsMetadata={effective:SettingChange[];defaults:SettingChange[];analysis?:{providerId:string;modelId:string}|null;imageModels?:Array<{providerId:string;id:string;label:string}>};
/** Setup evidence only: no browser connection, search request, or paid session is started. */
export type WebSettingsMetadata={effective:SettingChange[];defaults:SettingChange[];searchProviders?:Array<{id:string;label:string;implemented:boolean;available:boolean}>;resolvedSearch?:string|null};

/** Read-only requested execution policy and normalized communication preferences. Not runtime verification. */
export type RuntimeSettingsMetadata={effective:SettingChange[];defaults:SettingChange[]};
