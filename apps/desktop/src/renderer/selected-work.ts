import {useEffect, useRef, useState} from 'react';
import type {WorkProjection} from '@estacoda/control-protocol';
import type {DesktopAdapter} from './adapter.js';
import type {DesktopSnapshot} from '../shared/desktop-api.js';

/** A list page is not an exhaustive index of selectable Work. */
export function useSelectedWork(adapter: DesktopAdapter, snapshot: DesktopSnapshot, id: string) {
  const profile = snapshot.profile.id;
  const listed = snapshot.work.items.find(item => item.id === id);
  const required = adapter.kind === 'live' && id !== 'welcome' && id !== 'work-list' && !id.startsWith('draft-') && !listed;
  const [attempt, retry] = useState(0);
  const [lookup, setLookup] = useState<{profile: string; id: string; work?: WorkProjection; failed?: boolean}>();
  const failures=useRef({key:'',count:0});const lookupKey=JSON.stringify([profile,id,attempt]);if(failures.current.key!==lookupKey)failures.current={key:lookupKey,count:0};
  useEffect(() => {
    if (!required || snapshot.status !== 'ready') { setLookup(undefined); return; }
    let active = true;
    // Keep this same-profile Work mounted while its canonical projection refreshes.
    setLookup(previous => previous?.profile === profile && previous.id === id && (previous.work||previous.failed) ? previous : undefined);
    let timer:ReturnType<typeof setTimeout>;
    const read=async()=>{try{const work=await adapter.api.getWork(id);if(active)setLookup({profile,id,work});}
      catch{if(!active)return;if(++failures.current.count<4)timer=setTimeout(()=>void read(),250*failures.current.count);else setLookup(previous=>previous?.profile===profile&&previous.id===id&&previous.work?previous:{profile,id,failed:true});}};
    void read();return () => { active = false;clearTimeout(timer); };
  }, [adapter, id, profile, required, snapshot.status, snapshot.work, attempt]);
  const current = lookup?.profile === profile && lookup.id === id ? lookup : undefined;
  return {work: listed ?? (required ? current?.work : undefined),
    loading: required && !current, failed: required && !!current?.failed,
    retry: () => {setLookup(undefined);retry(value => value + 1);}};
}
