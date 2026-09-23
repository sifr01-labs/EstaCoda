import type {ReactNode} from 'react';
import {useEffect,useRef} from 'react';
import {BrandEye,Wordmark} from './primitives.js';
import {useI18n} from '../i18n.js';
import '../styles/onboarding.css';
export function OnboardingFrame({title,subtitle,brand=false,step,children,footer}:{title:string;subtitle?:string;brand?:boolean;step?:number;children:ReactNode;footer?:ReactNode}){
 const {t}=useI18n(),heading=useRef<HTMLHeadingElement>(null);
 useEffect(()=>{heading.current?.focus();},[title]);
 return <section className="ec-onboarding-flow" aria-label={t('Set up EstaCoda')}>
 <div className="ec-onboarding-content">
 <header className={brand?'ec-onboarding-heading ec-onboarding-brand':'ec-onboarding-heading'}>{brand?<Wordmark/>:<BrandEye/>}
 {step!==undefined&&<ol className="ec-onboarding-progress" aria-label={t('Setup progress')}>{(['Model','Workspace','Finish'] as const).map((name,i)=><li key={name} aria-current={step===i?'step':undefined} data-complete={i<step}><span>{i<step?'✓':i+1}</span>{t(name)}</li>)}</ol>}
 <h1 ref={heading} tabIndex={-1}>{title}</h1>{subtitle&&<p>{subtitle}</p>}</header>
 <div className="ec-onboarding-fields">{children}</div></div>
 {footer&&<footer className="ec-onboarding-footer">{footer}</footer>}
 </section>;
}
