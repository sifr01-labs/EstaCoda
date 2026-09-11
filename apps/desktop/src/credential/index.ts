import './style.css';
declare global { interface Window { credential: { describe(): Promise<{provider:string;purpose:string}>; submit(value:string): Promise<{accepted:boolean}>; cancel(): Promise<void> } } }
const input=document.querySelector<HTMLInputElement>('#secret')!;
const status=document.querySelector<HTMLElement>('#status')!;
void window.credential.describe().then(value=>{document.querySelector('#purpose')!.textContent=`${value.provider} · ${value.purpose}`;});
document.querySelector('form')!.addEventListener('submit',event=>{
  event.preventDefault();const value=input.value;input.value='';
  void window.credential.submit(value).then(()=>{status.textContent='Credential staged. Verification and reviewed apply are still required.';}).catch(()=>{status.textContent='Credential could not be staged. Reopen setup to try again.';});
});
document.querySelector('#cancel')!.addEventListener('click',()=>{input.value='';void window.credential.cancel();});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){input.value='';void window.credential.cancel();}});
