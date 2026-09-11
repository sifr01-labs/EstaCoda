import{useEffect,useRef,useState}from'react';import{createPortal}from'react-dom';import{Button,Icon}from'./primitives.js';
export function ProviderDialog({close,apply}:{close:()=>void;apply:(provider:string,model:string)=>void}){
 const[step,setStep]=useState(0),[provider,setProvider]=useState('Kimi'),[model,setModel]=useState('kimi-k3'),[staged,setStaged]=useState(false);
 const dialog=useRef<HTMLElement>(null),restore=useRef<HTMLElement|null>(null);
 useEffect(()=>{
  restore.current=document.activeElement as HTMLElement;
  const background=Array.from(document.querySelectorAll<HTMLElement>('#ec-shell-content,.ec-titlebar,.ec-runtimebar'));
  const previous=background.map(element=>element.inert);background.forEach(element=>{element.inert=true;});
  dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
  return()=>{background.forEach((element,index)=>{element.inert=previous[index]!;});if(restore.current?.isConnected)restore.current.focus();};
 },[]);
 useEffect(()=>{dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();},[step]);
 return createPortal(<div className="ec-modalback"><section ref={dialog} className="ec-modal" role="dialog" aria-modal="true" aria-labelledby="ec-setup-title" onKeyDown={event=>{
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();return;}
  if(event.key==='Tab'){
   const controls=Array.from(dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,[tabindex="0"]'));
   const first=controls[0],last=controls.at(-1);
   if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
   else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  }
 }}><div className="ec-modalhead"><h2 id="ec-setup-title">{step===2?'Provider added':step===1?'Review provider':'Add a provider'}</h2><Button className="ec-ghost ec-iconbutton" icon="x" aria-label="Close provider setup" onClick={close}/></div><p>Simulated setup · no network requests or real credentials.</p><div className="ec-steps"><span className={step===0?'ec-current':''}>1 Configure</span><span>/</span><span className={step===1?'ec-current':''}>2 Review</span><span>/</span><span className={step===2?'ec-current':''}>3 Ready</span></div>{step===0?<><label className="ec-field">Provider<select value={provider} onChange={event=>{const next=event.target.value;setProvider(next);setModel(next==='Local'?'local-model':'kimi-k3');setStaged(false);}}><option>Kimi</option><option>OpenAI-compatible</option><option>Local</option></select></label><label className="ec-field">Model ID<input autoComplete="off" value={model} maxLength={120} onChange={event=>setModel(event.target.value)}/></label>{provider==='Local'?<div className="ec-field">Credential<span>Not required for this local route</span></div>:<div className="ec-field">Credential<Button icon={staged?'check':'key-round'} onClick={()=>setStaged(true)}>{staged?'Sample credential staged':'Use sample credential'}</Button></div>}<div className="ec-actions"><Button className="ec-primary" disabled={!staged&&provider!=='Local'} onClick={()=>{setModel(model.trim()||'sample-model');setStep(1);}}>Simulate verification <Icon name="arrow-right"/></Button><Button onClick={close}>Cancel</Button></div></>:step===1?<><div className="ec-resolved"><Icon name="circle-check"/><div>Sample verification passed.</div></div><dl><div className="ec-kv"><dt>Provider / model</dt><dd><bdi>{provider} / {model}</bdi></dd></div><div className="ec-kv"><dt>Destination</dt><dd>Personal profile</dd></div><div className="ec-kv"><dt>Credential</dt><dd>{provider==='Local'?'Not required':'Sample value · staged until Apply'}</dd></div><div className="ec-kv"><dt>Default model</dt><dd>Kimi K3 remains selected</dd></div></dl><div className="ec-actions"><Button className="ec-primary" onClick={()=>{apply(provider,model);setStaged(false);setStep(2);}}>Apply demo configuration</Button><Button onClick={close}>Cancel</Button></div></>:<><div className="ec-resolved"><Icon name="circle-check"/><div><b>{provider} is ready in this concept</b><br/>Existing Work keeps its current model.</div></div><div className="ec-actions"><Button className="ec-primary" onClick={close}>Done</Button></div></>}</section></div>,document.querySelector('.ec-window')!);
}
