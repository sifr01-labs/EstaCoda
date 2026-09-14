import {useEffect,useRef,type ReactNode} from 'react';
import {Icon} from './primitives.js';

/** A disclosure keeps ordinary buttons in the native tab order. */
export function WorkPopover({label,icon,children,warning=false,iconOnly=false}:{label:string;icon:string;children:ReactNode;warning?:boolean;iconOnly?:boolean}){
 const ref=useRef<HTMLDetailsElement>(null);
 useEffect(()=>{
  const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&!ref.current?.contains(event.target)&&ref.current)ref.current.open=false;};
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&ref.current?.open){event.preventDefault();event.stopPropagation();ref.current.open=false;ref.current.querySelector('summary')?.focus();}};
  document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
  return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};
 },[]);
 return <details ref={ref} className={'ec-workpopover'+(warning?' ec-operation-warning':'')}><summary aria-label={label} title={iconOnly?label:undefined}><Icon name={icon}/>{!iconOnly&&<span>{label}</span>}</summary><div className="ec-workpopoverbody">{children}</div></details>;
}
