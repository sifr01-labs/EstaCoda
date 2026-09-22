export type InstallOwnership='development'|'unsupported'|'mounted'|'translocated'|'external'|'read_only'|'unverified'|'owned';
export type InstallationStatus={ownership:InstallOwnership;canReplace:boolean};
export type UpdatePhase='disabled'|'idle'|'checking'|'current'|'available'|'downloading'|'verifying'|'ready'|'installing'|'installed'|'failed';
export type UpdateProblem='release_setup'|'check_failed'|'incompatible'|'download_failed'|'insufficient_space'|'verification_failed'|'busy'|'active_runtime'|'restart_blocked'|'recovery_required';
export type DesktopUpdateState={phase:UpdatePhase;installation:InstallationStatus;version:string;availableVersion?:string;notesUrl?:string;progress?:number;problem?:UpdateProblem;automaticChecks:boolean};
export type DesktopUpdatesApi={status():Promise<DesktopUpdateState>;check():Promise<DesktopUpdateState>;download():Promise<DesktopUpdateState>;cancel():Promise<DesktopUpdateState>;install():Promise<DesktopUpdateState>;preferences(automaticChecks:boolean):Promise<DesktopUpdateState>;notes():Promise<void>;diagnostics():Promise<void>};
