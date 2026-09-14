import type {AppearancePreferences} from '../shared/appearance.js';
import {translate,type DisplayLanguage,type MessageKey} from '../shared/i18n/index.js';
declare global { interface Window { credential: { describe(): Promise<{provider:string;purpose:string;mode?:'setup'|'browser'|'work';language?:DisplayLanguage;appearance?:AppearancePreferences;field?:{label:string;origin:string;position:number;total:number}}>; submit(value:string): Promise<{accepted:boolean}>; cancel(): Promise<void> } } }
const input=document.querySelector<HTMLInputElement>('#secret')!;
let work=false,browser=false,language:DisplayLanguage='en',ready=false,busy=false;
const t=(key:MessageKey)=>translate(language,key);
const status=document.querySelector<HTMLElement>('#status')!;
void window.credential.describe().then(value=>{
 language=value.language==='ar'?'ar':'en';work=value.mode==='work';browser=value.mode==='browser'||work;
 document.documentElement.lang=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';
 const preferences=value.appearance;document.documentElement.dataset.appearance=preferences?.appearance??'system';document.documentElement.dataset.theme=preferences?.theme??'kemet';
 document.title=t('EstaCoda credential');
 document.querySelector('h1')!.textContent=t(browser?'Enter securely':'Add credential');
 document.querySelector('label')!.textContent=value.field?.label??t('Credential');
 document.querySelector('#cancel')!.textContent=t('Cancel');
 document.querySelector('button[type=submit]')!.textContent=t(work?'Provide securely':browser?'Enter and submit':'Stage credential');
 status.textContent=t(work?'Used once for the verified browser form. Never added to chat.':browser?'Sent once to the verified browser field and submit control. Never added to chat.':'Held temporarily until a reviewed setup transaction applies it.');
 document.querySelector('#purpose')!.textContent=value.field?value.field.origin+' · '+value.field.position+' / '+value.field.total:value.provider;
 ready=true;input.focus();
}).catch(()=>{status.textContent=t('Credential could not be staged. Reopen setup to try again.');});
document.querySelector('form')!.addEventListener('submit',event=>{
 event.preventDefault();if(!ready||busy||!input.value)return;busy=true;const button=document.querySelector<HTMLButtonElement>('button[type=submit]')!;button.disabled=true;const value=input.value;input.value='';
 void window.credential.submit(value).then(()=>{status.textContent=t(work?'Secure value provided.':browser?'Entry submitted.':'Credential staged. Verification and reviewed apply are still required.');}).catch(()=>{status.textContent=t(browser?'Entry failed. Cancel and inspect the browser before trying again.':'Credential could not be staged. Reopen setup to try again.');}).finally(()=>{busy=false;button.disabled=false;input.focus();});
});
document.querySelector('#cancel')!.addEventListener('click',()=>{input.value='';void window.credential.cancel();});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){input.value='';void window.credential.cancel();}});
