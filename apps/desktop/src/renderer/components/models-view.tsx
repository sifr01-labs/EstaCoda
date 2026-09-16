import type {DesktopModelsApi} from '../../shared/desktop-api.js';
import type {FixtureControls} from '../adapter.js';
import {LiveModels} from './live-models.js';
export function ModelsView({fixture,models,profile}:{fixture?:FixtureControls;models?:DesktopModelsApi;profile?:string}){
 return <LiveModels key={profile} api={models} profile={profile} illustrative={Boolean(fixture)}/>;
}
