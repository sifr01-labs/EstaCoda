/** Public, bounded presentation metadata. No paths to profile files or raw credentials. */
export type SettingValue=string|number|boolean|string[]|null;
export type SettingsSection='models'|'vision'|'voice'|'browser'|'runtime'|'governance'|'channels'|'capabilities';
export const SETTINGS_SECTIONS:readonly SettingsSection[]=['models','vision','voice','browser','runtime','governance','channels','capabilities'];
export type SettingField={id:string;section:SettingsSection;path:string[];kind:'text'|'number'|'boolean'|'choice'|'strings'|'secret';choices?:Array<string|number|boolean>;min?:number;max?:number};
export type SettingChange={fieldId:string;selectors:string[];value:SettingValue};
export type SettingsPage={fields:SettingField[];values:SettingChange[];truncated:boolean;nextOffset?:number};
export type SettingsReview={draftId:string;changes:SettingChange[];previous:SettingChange[];expiresInMs:number};
export type SettingsBinding={draftId:string;windowId:string;generation:number};
