import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
const repo=process.cwd(),root=process.argv[2],home=join(root,'evaluation/home');
const fixture=JSON.parse(await readFile(join(root,'fixture.json'),'utf8'));
const {loadRuntimeConfig}=await import(join(repo,'src/config/runtime-config.ts'));
const {resolveProfileStateHome}=await import(join(repo,'src/config/profile-home.ts'));
const {SkillRegistry}=await import(join(repo,'src/skills/skill-registry.ts'));
const {parseSkillFile}=await import(join(repo,'src/skills/skill-loader.ts'));
const {SkillEvolutionStore}=await import(join(repo,'src/skills/skill-evolution.ts'));
const {SkillProposalService}=await import(join(repo,'src/skills/skill-proposal-service.ts'));
const {deriveAgentEvolutionPolicy}=await import(join(repo,'src/contracts/agent-evolution.ts'));
const {skillContentHash}=await import(join(repo,'src/skills/skill-task-evaluation.ts'));
const {proposalCommand}=await import(join(repo,'src/cli/proposal-commands.ts'));
const config=await loadRuntimeConfig({workspaceRoot:repo,configurationInspection:true});
const auth=JSON.parse(await readFile(resolveProfileStateHome({profileId:config.profileId}).authJsonPath,'utf8'));
const token=auth.providers.codex;if(!token?.accessToken)throw Error('No selected Codex token');
const profile=join(home,'.estacoda/profiles/default'),skills=join(profile,'skills');await mkdir(join(skills,'ledger-close'),{recursive:true});
const path=join(skills,'ledger-close/SKILL.md');await writeFile(path,fixture.skillV1);
const {refreshToken,...accessOnly}=token;await writeFile(join(profile,'auth.json'),JSON.stringify({version:auth.version,providers:{codex:accessOnly}}),{mode:0o600});
await writeFile(join(profile,'config.json'),await readFile(join(root,'after/home/.estacoda/profiles/default/config.json')),{mode:0o600});
const registry=new SkillRegistry();registry.register(parseSkillFile(path,fixture.skillV1,{sourceRoot:skills,sourceKind:'local'}));
const store=new SkillEvolutionStore({usagePath:join(skills,'.usage.json'),evolutionRoot:join(skills,'.evolution')});
const service=new SkillProposalService({registry,localSkillsRoot:skills,skillEvolutionStore:store});
const candidate=await store.appendLearningCandidate({kind:'selected_skill_refinement',selectedSkill:'ledger-close',suggestedTarget:'skill_patch',evidenceIds:[],reason:'Operator changed close policy from v1 to v2. Validate the proposed instruction update against independently calculated outputs.'});
const oldString=fixture.skillV1.split('\n').find(line=>line.startsWith('Policy v1:'));
const newString=fixture.skillV2.split('\n').find(line=>line.startsWith('Policy v2:'));
const draft=await service.createProposalFromLearningCandidate({candidate,agentEvolutionPolicy:deriveAgentEvolutionPolicy('proactive'),patch:{type:'text_patch',oldString,newString},baseContentHash:skillContentHash(fixture.skillV1)});if(!draft.ok)throw Error(draft.reason);
function expected(csv){const rows=csv.trim().split('\n').slice(1).map(line=>{const [id,currency,type,status,amount]=line.split(',');return {id,currency,type,status,cents:Math.round(Number(amount)*100)}});const chosen=[...new Map(rows.map(r=>[r.id,r])).values()].filter(r=>r.status==='posted');const totals={};for(const r of chosen)totals[r.currency]=(totals[r.currency]??0)+r.cents*(r.type==='credit'?-1:1);return {policy:'v2',totals:Object.fromEntries(Object.entries(totals).map(([k,v])=>[k,(v/100).toFixed(2)])),includedIds:chosen.map(r=>r.id).sort()};}
const suite={version:1,id:'ledger-close-policy-v2',cases:[1,2].map(n=>({id:`batch-${n}`,instruction:'Reconcile this invoice export according to the supplied skill procedure. Return its JSON output.',input:fixture[`csv${n}`],expected:expected(fixture[`csv${n}`])}))};
const suitePath=join(root,'evaluation/suite.json');await writeFile(suitePath,JSON.stringify(suite,null,2));
try{
 const result=await proposalCommand({workspaceRoot:repo,homeDir:home,profileId:'default'},['test',draft.proposal.id,suitePath]);
 const proposal=await service.findProposal(draft.proposal.id);
 const blocked=await service.promoteProposal(draft.proposal.id);
 const liveUnchanged=await readFile(path,'utf8')===fixture.skillV1;
 await writeFile(join(root,'evaluation/result.json'),JSON.stringify({command:result,proposal,unapprovedPromotion:blocked,liveUnchanged},null,2));
 console.log(JSON.stringify({exitCode:result.exitCode,output:result.output,source:proposal.taskEvaluationSource,liveUnchanged,unapprovedPromotion:blocked.ok}));
}finally{await rm(join(profile,'auth.json'),{force:true});}
