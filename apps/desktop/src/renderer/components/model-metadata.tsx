import type {ModelProjection, Page, ProviderProjection} from '@estacoda/control-protocol';
import {Coins, Scan, Wrench, Image} from 'lucide-react';
import {useI18n} from '../i18n.js';

export const modelKey=(m:{providerId:string;id:string})=>JSON.stringify([m.providerId,m.id]);
export const canSetUp=(p:ProviderProjection)=>Boolean(p.metadata?.configurable&&p.metadata.runnable&&(p.authMethods.includes('api_key')||p.authMethods.includes('none')||p.id==='codex'));
/** Drain an opaque snapshot, never compare a partially loaded catalog to a complete one. */
export async function catalogPages<T>(read:(cursor?:string)=>Promise<Page<T>>,current:()=>boolean=()=>true):Promise<T[]>{
 const items:T[]=[],seen=new Set<string>();let cursor:string|undefined;
 do{if(!current())throw new Error('Catalog request superseded');const page=await read(cursor);items.push(...page.items);if(page.nextCursor&&seen.has(page.nextCursor))throw new Error('Catalog cursor repeated');cursor=page.nextCursor??undefined;if(cursor)seen.add(cursor);}while(cursor);
 return items;
}
export function modelPrice(value:number|null|undefined){return typeof value==='number'&&Number.isFinite(value)&&value>=0?'$'+new Intl.NumberFormat('en-US',{maximumFractionDigits:6}).format(value):null;}
export function ModelRates({model}:{model?:ModelProjection}){
 const {t}=useI18n();return <span className="ec-model-rates">{(['inputPerMillion','outputPerMillion'] as const).map((field,i)=><span key={field}><span className="ec-rate-label">{i?t('Output'):t('Input')}</span><bdi dir="ltr" aria-label={t(i?'Output price: {price} USD per 1M tokens':'Input price: {price} USD per 1M tokens',{price:modelPrice(model?.catalog?.price?.[field])??t('Unavailable')})}>{modelPrice(model?.catalog?.price?.[field])??'—'}</bdi></span>)}</span>;
}
export function ModelMetadata({model,prices=true}:{model?:ModelProjection;prices?:boolean}){
 const {t,language}=useI18n(),catalog=model?.catalog;
 const context=catalog?.contextTokens?new Intl.NumberFormat(language,{notation:'compact',maximumFractionDigits:1}).format(catalog.contextTokens):t('Unknown');
 return <span className="ec-model-metadata"><span className="ec-model-capabilities"><span><Scan/>{t('{size} context',{size:context})}</span>{catalog?.tools&&<span><Wrench/>{t('Tools')}</span>}{catalog?.vision&&<span><Image/>{t('Images')}</span>}</span>{prices&&<span className="ec-model-price" title={t('Catalog rates in USD per million tokens. Cached input, discounts, and account-specific pricing may differ.')}><Coins/>{catalog?.price?<><bdi dir="ltr">{modelPrice(catalog.price.inputPerMillion)??'—'}</bdi> {t('input')} · <bdi dir="ltr">{modelPrice(catalog.price.outputPerMillion)??'—'}</bdi> {t('output')} <span>{t('/ 1M tokens')}</span></>:t('Price unavailable')}</span>}</span>;
}
