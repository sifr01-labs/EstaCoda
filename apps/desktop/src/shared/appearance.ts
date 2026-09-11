export const THEMES=['kemet','graphite','sand'] as const;
export const APPEARANCES=['system','light','dark'] as const;
export type AppearancePreferences={theme:typeof THEMES[number];appearance:typeof APPEARANCES[number];density:'comfortable'|'compact'};
export const DEFAULT_APPEARANCE:AppearancePreferences={theme:'kemet',appearance:'system',density:'comfortable'};
export function validAppearance(value:unknown):value is AppearancePreferences {
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const record=value as Record<string,unknown>;
 return Object.keys(record).length===3&&THEMES.includes(record.theme as never)&&APPEARANCES.includes(record.appearance as never)&&['comfortable','compact'].includes(String(record.density));
}
export type AppearanceStore={read():Promise<AppearancePreferences>;write(value:AppearancePreferences):Promise<void>};
