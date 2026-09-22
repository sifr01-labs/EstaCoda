export type RestartEvidence={compatible:boolean;readersCoordinated:boolean;runtimeAssetsRetained:boolean;running:number|null;queued:number|null;terminals:number;browserTakeovers:number;credentialEntries:number;draftsSaved:boolean};
/** Recompute at restart, inside the coordinator. Unknown evidence never authorizes replacement. */
export function restartBlock(e:RestartEvidence):'incompatible'|'active_runtime'|'restart_blocked'|undefined {
 if(e.compatible!==true)return'incompatible';
 if(e.readersCoordinated!==true||e.runtimeAssetsRetained!==true||e.running!==0||e.queued!==0)return'active_runtime';
 if(e.terminals!==0||e.browserTakeovers!==0||e.credentialEntries!==0||e.draftsSaved!==true)return'restart_blocked';
 return undefined;
}
