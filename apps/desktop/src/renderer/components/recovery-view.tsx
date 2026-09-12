import {LanguageSelect} from './language-select.js';
import {useI18n} from '../i18n.js';
import type{DesktopSnapshot}from'../../shared/desktop-api.js';import{Topline,Button,Icon}from'./primitives.js';
export function RecoveryView({snapshot,retry}:{snapshot:DesktopSnapshot;retry:()=>void}){
 const {t}=useI18n();
 const copy=({connecting:['Connecting to your runtime','Loading this profile’s canonical Work and attention items.'],disconnected:['Connection interrupted','Reconnecting to the runtime. Work continues under its existing execution owner.'],unavailable:['Profile inspection unavailable','The runtime could not inspect this profile. Retry, or use the CLI to check profile compatibility and repair the installation.'],incompatible:['Runtime update required','This app and the control service use incompatible protocol versions. Update the installation before reconnecting.'],ready:['Ready','Your profile is connected.']} as const)[snapshot.status];
 return <><Topline label={t("Runtime")} profile={snapshot.profile.label}/><div className="ec-page"><div className="ec-empty" role="status"><Icon name={snapshot.status==='connecting'?'loader-circle':'circle-alert'}/><LanguageSelect/><h1>{t(copy[0])}</h1><p>{t(copy[1])}</p>{snapshot.status!=='connecting'&&<div className="ec-actions" style={{justifyContent:'center'}}><Button onClick={retry}>{t("Reconnect")}</Button></div>}</div></div></>;
}
export function SetupNotice({snapshot,configureModels}:{snapshot:DesktopSnapshot;configureModels?:()=>void}){
 const {t,owned}=useI18n();
 if(snapshot.status!=='ready')return null;
 const configuration=snapshot.profile.configuration;
 if(configuration==='ready'&&snapshot.runtime!=='incompatible')return null;
 return <div className="ec-production-notice" role="status"><Icon name="circle-alert"/><div>{configuration!=='ready'&&<LanguageSelect/>}<b>{snapshot.runtime==='incompatible'?t("Execution host update required"):configuration==='repair_required'?t("Profile needs repair"):t("Set up your profile")}</b><p>{snapshot.runtime==='incompatible'?t("The existing host is incompatible. Existing Work remains inspectable; no second execution host is started."):configuration==='repair_required'?t("Repair this selected profile with the CLI setup editor. Existing Work remains available for inspection."):configureModels?t("Choose a model route in Models & providers to start new Work."):t("Configure a model route with the CLI setup editor to start new Work.")}</p>{configuration==='unconfigured'&&configureModels?<Button onClick={configureModels}>{t("Configure models")}</Button>:configuration!=='ready'&&<code>estacoda --profile {snapshot.profile.id} setup</code>}</div></div>;
}
