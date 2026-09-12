import {useAppearance} from '../appearance.js';
import {useI18n} from '../i18n.js';
import {isDisplayLanguage} from '../../shared/i18n/index.js';
export function LanguageSelect(){
 const{preferences,change}=useAppearance(),{t}=useI18n();
 return <div className="ec-settingsrow"><div><h3>{t('Display language')}</h3><p>{t('Changes this app only. Agent response language is configured separately.')}</p></div><select aria-label={t('Display language')} value={preferences.language??'en'} onChange={event=>{if(isDisplayLanguage(event.target.value))change({language:event.target.value});}}><option value="en" lang="en">English</option><option value="ar" lang="ar">العربية</option></select></div>;
}
