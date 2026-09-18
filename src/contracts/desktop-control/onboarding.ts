/** Setup projections contain status only; core diagnostics and credential values stay private. */
export const SETUP_STATES = ['new-user','configured-ready','configured-degraded','partial-provider','missing-secret','broken-config','untrusted-workspace','state-not-writable'] as const;
export type SetupDetection = {state:typeof SETUP_STATES[number];mode:'first-run'|'repair'|'ready';writable:boolean;launchReady:boolean;pendingApply:boolean};
/** Bridge/schema compatibility must also pass the normal connection handshake. */
export type LocalSetupInspection = {profileId:string;configuration:SetupDetection;runtime:import('./bootstrap.js').BootstrapResult['runtime']['state'];compatibility:'compatible'|'incompatible'|'unavailable';canConnect:boolean};
export type OnboardingWorkspaceReview={reviewId:string;path:string;alias:string;trust:boolean};
export type OnboardingReview={reviewId:string;route:import('./model-setup.js').ModelRouteDraft;changes:import('./settings.js').SettingChange[];workspace:OnboardingWorkspaceReview};
export type OnboardingVerification={detection:SetupDetection;workspace:string|null;target:import('./projections.js').TargetReference|null};
