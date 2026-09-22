export type RestartEvidence={compatible:boolean;readersCoordinated:boolean;runtimeAssetsRetained:boolean;running:number|null;queued:number|null;terminals:number;browserTakeovers:number;credentialEntries:number;draftsSaved:boolean};
/** Recompute at restart, inside the coordinator. Unknown evidence never authorizes replacement. */
export function restartBlock(e:RestartEvidence):'incompatible'|'active_runtime'|'restart_blocked'|undefined {
 if(!e.compatible)return'incompatible';
 if(!e.readersCoordinated||!e.runtimeAssetsRetained||e.running===null||e.queued===null||e.running>0||e.queued>0)return'active_runtime';
 if(e.terminals||e.browserTakeovers||e.credentialEntries||!e.draftsSaved)return'restart_blocked';
 return undefined;
}
