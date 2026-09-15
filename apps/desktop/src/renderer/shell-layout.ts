import {useEffect,useState,type PointerEvent,type KeyboardEvent} from 'react';
const key='estacoda.shell-layout';
const clamp=(width:number)=>Math.min(360,Math.max(200,width));
export function useShellLayout(){
 const [layout,setLayout]=useState(()=>{try{const value=JSON.parse(localStorage.getItem(key)??'null');if(typeof value?.visible==='boolean'&&Number.isFinite(value.width))return{visible:window.innerWidth>650&&value.visible,width:clamp(value.width)};}catch{}return{visible:window.innerWidth>650,width:240};});
 useEffect(()=>{try{localStorage.setItem(key,JSON.stringify(layout));}catch{}},[layout]);
 useEffect(()=>{const narrow=window.matchMedia('(max-width:650px)');const changed=()=>{if(narrow.matches)setLayout(previous=>({...previous,visible:false}));};narrow.addEventListener('change',changed);return()=>narrow.removeEventListener('change',changed);},[]);
 const toggle=()=>setLayout(previous=>({...previous,visible:!previous.visible}));
 useEffect(()=>{const listener=(event:globalThis.KeyboardEvent)=>{if((event.metaKey||event.ctrlKey)&&event.shiftKey&&event.key.toLowerCase()==='b'&&!document.querySelector('[aria-modal=true]')){event.preventDefault();toggle();}};window.addEventListener('keydown',listener);return()=>window.removeEventListener('keydown',listener);},[]);
 const resize=(event:PointerEvent<HTMLDivElement>)=>{event.preventDefault();const element=event.currentTarget;const rtl=getComputedStyle(element).direction==='rtl';element.setPointerCapture(event.pointerId);const start=event.clientX,width=layout.width;
 const move=(next:globalThis.PointerEvent)=>setLayout(previous=>({...previous,width:clamp(width+(next.clientX-start)*(rtl?-1:1))}));
 const end=()=>{element.removeEventListener('pointermove',move);element.removeEventListener('lostpointercapture',end);};element.addEventListener('pointermove',move);element.addEventListener('lostpointercapture',end);};
 const resizeKey=(event:KeyboardEvent)=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const rtl=getComputedStyle(event.currentTarget).direction==='rtl';setLayout(previous=>({...previous,width:event.key==='Home'?200:event.key==='End'?360:clamp(previous.width+(event.key==='ArrowRight'?16:-16)*(rtl?-1:1))}));}};
 return{...layout,toggle,close:()=>setLayout(previous=>({...previous,visible:false})),resize,resizeKey};
}
