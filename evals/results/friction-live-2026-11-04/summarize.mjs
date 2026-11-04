// Recompute the compact evidence packet from fresh live-run receipts, not answer prose.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const root = process.argv[2];
if (!root?.startsWith('/private/tmp/')) throw Error('Expected benchmark root');
const hash = x => createHash('sha256').update(x).digest('hex');
const read = async p => JSON.parse(await readFile(p, 'utf8'));
const manifest = await read(join(root, 'evidence/manifest.json'));
const cases = [];
for (const arm of ['before', 'after']) for (const test of Object.keys(manifest.cases)) {
  const dir = join(root, 'evidence', arm, test);
  const summary = await read(join(dir, 'summary.json'));
  const sessions = await read(join(dir, 'transcript.json'));
  const usage = await read(join(dir, 'usage.json'));
  const calls = sessions.flatMap(s => s.events.filter(e => e.kind === 'tool-plan').map(e => ({sessionId:s.session.id, ...e.plan})));
  const denied = sessions.flatMap(s => s.events.filter(e => e.kind === 'security-assessed' && e.assessment.decision === 'deny').map(e => ({sessionId:s.session.id, tool:e.tool, riskClass:e.riskClass, rule:e.assessment.deterministicRule, reason:e.assessment.reason})));
  const validations = sessions.flatMap(s => s.events.filter(e => e.kind === 'step-completion-validation').map(e => ({sessionId:s.session.id, accepted:e.accepted, repair:e.repair, feedback:e.feedback})));
  const changedProtectedInputs = [];
  for (const [p, expected] of Object.entries(manifest.inputHashes)) {
    if (!p.startsWith('src/') && p !== 'setup-lab/verify.test.mjs') continue;
    const bytes = await readFile(join(root,arm,test,'workspace',p)).catch(()=>null);
    if (!bytes || hash(bytes) !== expected) changedProtectedInputs.push(p);
  }
  const tasks = summary.tasks.map(t => ({status:t.task.status, steps:t.steps.map(s => ({id:s.id, role:s.executor.role, status:s.status})),
    attempts:t.attempts.map(a=>({stepId:a.stepId, workerSessionId:a.workerSessionId, failure:a.failure, usage:a.usage})),
    results:t.results.map(r=>({id:r.id, stepId:r.stepId, disposition:r.disposition, bytes:r.byteLength, sha256:r.contentHash}))}));
  const synthesisIds = new Set(tasks.flatMap(t=>t.steps.filter(s=>s.role==='synthesis').map(s=>s.id)));
  const acceptedSyntheses = tasks.flatMap(t=>t.results.filter(r=>r.disposition==='accepted' && synthesisIds.has(r.stepId)));
  const report = summary.reportExists ? {bytes:summary.reportExists.bytes, sha256:summary.reportExists.sha256,
    equalsAcceptedSynthesis:acceptedSyntheses.some(r=>r.sha256.replace(/^sha256:/,'')===summary.reportExists.sha256)} : null;
  const deliveryIds = new Set(tasks.flatMap(t=>t.steps.filter(s=>s.role==='report-delivery').map(s=>s.id)));
  cases.push({arm,test, elapsedMs:summary.elapsedMs, providerCalls:summary.providerCalls,
    deliveryProviderCalls:usage.filter(u=>deliveryIds.has(u.stepId)).length,
    changedProtectedInputs, report, tasks, denied, validations,
    processReceipts:calls.filter(c=>['terminal.run','process.logs'].includes(c.tool)).map(c=>({id:c.id,sessionId:c.sessionId, tool:c.tool,
      command:c.input?.command, ok:c.result?.ok, code:c.result?.metadata?.code ?? c.result?.metadata?.process?.exitCode,
      verification:c.input?.verification, output:c.result?.content?.slice(-2200)})),
    inspectionReceipts:calls.filter(c=>['terminal.inspect','file.grep'].includes(c.tool)).map(c=>({id:c.id,tool:c.tool,input:c.input,ok:c.result?.ok})),
    sourceEvidenceHashes:Object.fromEntries(await Promise.all((await readdir(dir)).filter(p=>p.endsWith('.json')).map(async p=>[p,hash(await readFile(join(dir,p)))])))
  });
}
const output = {baseline:manifest.baseline, model:manifest.model, budgets:manifest.budgets, securityMode:manifest.securityMode,
 scope:manifest.scope, pilotNote:manifest.pilotNote, inputManifestSha256:hash(JSON.stringify(manifest.inputHashes)),
 runtimeSourceHashes:Object.fromEntries(Object.entries(manifest.updatedSourceHashes).filter(([p])=>!p.endsWith('.test.ts'))), cases};
await writeFile(join(process.cwd(),'evals/results/friction-live-2026-11-04/evidence.json'),JSON.stringify(output,null,2)+'\n');
console.log(cases.map(c=>({arm:c.arm,test:c.test,calls:c.providerCalls,status:c.tasks.map(t=>t.status),report:c.report,protectedInputsUnchanged:c.changedProtectedInputs.length===0})));
