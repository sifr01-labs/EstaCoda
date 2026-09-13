/** Setup projections contain status only; core diagnostics and credential values stay private. */
export const SETUP_STATES = ['new-user','configured-ready','configured-degraded','partial-provider','missing-secret','broken-config','untrusted-workspace','state-not-writable'] as const;
export type SetupDetection = {state:typeof SETUP_STATES[number];mode:'first-run'|'repair'|'ready';writable:boolean;launchReady:boolean;pendingApply:boolean};
