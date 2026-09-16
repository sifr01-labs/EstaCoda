import type {ReactNode} from 'react';
import {Icon} from './primitives.js';

/** Uses the same identity, surface and metadata rhythm as the model selection cards. */
export function CapabilityCard({icon,title,description,children,action}:{icon:ReactNode;title:ReactNode;description?:ReactNode;children?:ReactNode;action?:ReactNode}){
 return <div className="ec-primary-model ec-capability-card"><span className="ec-model-mark" aria-hidden="true">{icon}</span><div className="ec-model-grow"><h3>{title}</h3>{description&&<p>{description}</p>}{children&&<div className="ec-model-metadata ec-media-metadata">{children}</div>}</div>{action}</div>;
}
export function CapabilityFact({icon,children,tone}:{icon:string;children:ReactNode;tone?:'good'|'warn'}){return <span className={tone==='good'?'ec-media-good':tone==='warn'?'ec-web-warn':undefined}><Icon name={icon}/>{children}</span>;}
