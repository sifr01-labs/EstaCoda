import './style.css';
declare global { interface Window { credential: { describe(): Promise<{provider:string;purpose:string;mode?:'setup'|'browser'}>; submit(value:string): Promise<{accepted:boolean}>; cancel(): Promise<void> } } }
const input=document.querySelector<HTMLInputElement>('#secret')!;
let browser=false;
const status=document.querySelector<HTMLElement>('#status')!;
void window.credential.describe().then(value=>{browser=value.mode==='browser';if(browser){document.querySelector('h1')!.textContent='Enter securely';document.querySelector('button[type=submit]')!.textContent='Enter and submit';status.textContent='Sent once to the verified browser field and submit control. Never added to chat.';}document.querySelector('#purpose')!.textContent=`${value.provider} · ${value.purpose}`;});
document.querySelector('form')!.addEventListener('submit',event=>{
  event.preventDefault();const value=input.value;input.value='';
  void window.credential.submit(value).then(()=>{status.textContent=browser?'Entry submitted.': 'Credential staged. Verification and reviewed apply are still required.';}).catch(()=>{status.textContent=browser?'Entry failed. Cancel and inspect the browser before trying again.':'Credential could not be staged. Reopen setup to try again.';});
});
document.querySelector('#cancel')!.addEventListener('click',()=>{input.value='';void window.credential.cancel();});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){input.value='';void window.credential.cancel();}});
