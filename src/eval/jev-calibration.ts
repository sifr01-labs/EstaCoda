/** Offline scoring for live Jev traces. Expected labels never enter model requests. */
export type JevCalibrationCase = {
  id: string; family: string; split: 'development' | 'calibration' | 'acceptance'; language: string; prompt: string;
  required: Record<'intents' | 'skills' | 'tools', Array<string | string[]>>;
  acceptable: Record<'intents' | 'skills' | 'tools', string[]>;
  continuity?: string; saveOnly?: boolean; discovery?: boolean;
  material?: Array<{kind: 'quoted' | 'retrieved'; text: string}>;
};
export type Selection = Record<'intents' | 'skills' | 'tools', string[]>;
const infrastructure = new Set(['capability.discover','capability.request','config.provider.execution_status','plan','skill.read','skill.view','skill.list','skill.inspect','skill.search']);
export function scoreSelection(row: JevCalibrationCase, selected: Selection) {
  return Object.fromEntries((['intents','skills','tools'] as const).map(stage => {
    const groups=row.required[stage].map(item=>typeof item==='string'?[item]:item);
    const allowed=new Set([...groups.flat(),...row.acceptable[stage]]);
    const actual=[...new Set(selected[stage])];
    // Always-on inspection/recovery infrastructure is measured separately, not called irrelevant.
    const irrelevant=actual.filter(id=>!allowed.has(id)&&!(stage==='tools'&&infrastructure.has(id)));
    const missing=groups.filter(group=>!group.some(id=>actual.includes(id)));
    return [stage,{required:groups.length,met:groups.length-missing.length,missing,irrelevant,selected:actual.length,
      infrastructure:stage==='tools'?actual.filter(id=>infrastructure.has(id)&&!allowed.has(id)):[]}];
  })) as Record<'intents'|'skills'|'tools',{required:number;met:number;missing:string[][];irrelevant:string[];selected:number;infrastructure:string[]}>;
}
export function summarizeSelections(rows: Array<{row:JevCalibrationCase;selected:Selection}>) {
  return Object.fromEntries((['intents','skills','tools'] as const).map(stage=>{
    const scores=rows.map(({row,selected})=>scoreSelection(row,selected)[stage]);
    const required=scores.reduce((n,s)=>n+s.required,0),met=scores.reduce((n,s)=>n+s.met,0);
    return [stage,{required,met,recall:required?met/required:null,irrelevantSelections:scores.reduce((n,s)=>n+s.irrelevant.length,0),
      casesWithMiss:scores.filter(s=>s.missing.length).length,casesWithIrrelevant:scores.filter(s=>s.irrelevant.length).length,
      totalSelections:scores.reduce((n,s)=>n+s.selected,0)}];
  }));
}
export function validateCalibrationCorpus(rows:JevCalibrationCase[]) {
 const ids=new Set<string>(),families=new Map<string,string>();
 for(const row of rows){
  if(ids.has(row.id)||!row.prompt.trim())throw Error('Duplicate ID or empty request');ids.add(row.id);
  if(families.has(row.family)&&families.get(row.family)!==row.split)throw Error('Scenario family crosses splits');families.set(row.family,row.split);
  for(const stage of ['intents','skills','tools'] as const){
   if(!Array.isArray(row.required[stage])||!Array.isArray(row.acceptable[stage]))throw Error('Missing labels');
   for(const group of row.required[stage])if((typeof group==='string'?!group:!group.length||group.some(id=>!id)))throw Error('Empty requirement');
  }
 }
}

export type CandidateProbability={stage:'intents'|'skills'|'tools';id:string;probability?:number;status:string};
/** Optional/alternative candidates are excluded from probability calibration: relevance is not mandatory use. */
export function probabilityCalibration(rows:Array<{row:JevCalibrationCase;candidates:CandidateProbability[]}>){
 return Object.fromEntries((['intents','skills','tools'] as const).map(stage=>{
  const bins=Array.from({length:5},(_,i)=>({from:i*.2,to:(i+1)*.2,count:0,sumProbability:0,positives:0,squaredError:0}));
  let unresolved=0,missing=0,positiveCount=0,negativeCount=0,positiveError=0,negativeError=0;
  for(const {row,candidates} of rows){
   const required=new Set(row.required[stage].filter((v):v is string=>typeof v==='string'));
   const optional=new Set([...row.acceptable[stage],...row.required[stage].filter(Array.isArray).flat()]);
   for(const c of candidates.filter(c=>c.stage===stage)){
    if(['uncertain','missing','invalid'].includes(c.status))unresolved++;
    if(c.probability===undefined){missing++;continue;}
    if(!required.has(c.id)&&(optional.has(c.id)||(stage==='tools'&&infrastructure.has(c.id))))continue;
    const y=required.has(c.id)?1:0,p=c.probability,error=(p-y)**2,bin=bins[Math.min(4,Math.floor(p*5))];
    bin.count++;bin.sumProbability+=p;bin.positives+=y;bin.squaredError+=error;
    if(y){positiveCount++;positiveError+=error;}else{negativeCount++;negativeError+=error;}
   }
  }
  return [stage,{unresolved,missing,positiveCount,negativeCount,
   positiveBrier:positiveCount?positiveError/positiveCount:null,negativeBrier:negativeCount?negativeError/negativeCount:null,
   bins:bins.map(b=>({from:b.from,to:b.to,count:b.count,meanProbability:b.count?b.sumProbability/b.count:null,observedPositiveRate:b.count?b.positives/b.count:null}))}];
 }));
}
