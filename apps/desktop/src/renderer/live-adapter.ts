import type{DesktopAdapter}from'./adapter.js';
/** Production entry only: an absent preload is an unavailable runtime, never demo data. */
export function liveAdapter():DesktopAdapter {
 const api=window.desktop;
 return{kind:'live',api,appearance:{read:()=>api.appearance(),write:value=>api.setAppearance(value)}};
}
