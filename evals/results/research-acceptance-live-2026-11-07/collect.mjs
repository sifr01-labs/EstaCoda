// Summarize retained live evidence without copying credentials or personal state.
import { readFile, writeFile, mkdir, readdir, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(process.argv[2] ?? ''), destination = resolve(process.argv[3] ?? '');
if (!root.startsWith('/private/tmp/estacoda-research-acceptance-') || !destination.includes('/evals/results/research-acceptance-live-2026-11-07/'))
  throw Error('Expected isolated benchmark evidence and repository packet destination.');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const evidence = join(root, 'evidence');
const manifest = await json(join(evidence, 'manifest.json'));
await mkdir(destination, { recursive: true });
await copyFile(join(evidence, 'manifest.json'), join(destination, 'manifest.json'));
const runs = [];
for (const arm of ['before', 'after']) {
  for (const test of await readdir(join(evidence, arm)).catch(() => [])) {
    const directory = join(evidence, arm, test);
    const summary = await json(join(directory, 'summary.json')).catch(() => undefined);
    if (!summary) continue;
    const usage = await json(join(directory, 'usage.json'));
    const workspace = join(root, arm, test, 'workspace');
    const target = join(destination, arm, test);
    await mkdir(target, { recursive: true });
    const results = summary.tasks.flatMap(t => t.results);
    const reports = [];
    const reportPaths = new Set([
      ...(await readdir(join(workspace, 'reports')).catch(() => [])).map(name => `reports/${name}`),
      ...summary.tasks.flatMap(t => t.steps.map(step => step.executor.requestContract?.requirements?.fileOutput?.path))
    ].filter(path => typeof path === 'string' && !path.startsWith('/') && !path.split('/').includes('..')));
    for (const path of reportPaths) {
      const bytes = await readFile(join(workspace, path)).catch(() => undefined);
      if (!bytes) continue;
      const sha256 = hash(bytes);
      await writeFile(join(target, 'export-' + path.split('/').at(-1)), bytes);
      reports.push({ path, bytes: bytes.length, sha256,
        matchesAcceptedResult: results.some(result => result.disposition === 'accepted' && result.contentHash === `sha256:${sha256}`) });
    }
    const inputChanges = [];
    for (const [path, expected] of Object.entries(manifest.inputHashes)) {
      const bytes = await readFile(join(workspace, path)).catch(() => undefined);
      if (!bytes || hash(bytes) !== expected) inputChanges.push(path);
    }
    for (const file of await readdir(directory)) {
      if (file.endsWith('.md') || (file.startsWith('diagnostic-') && file.endsWith('.json'))) {
        const text = await readFile(join(directory, file), 'utf8');
        await writeFile(join(target, file), file.endsWith('.md') ? text.replace(/[\t ]+$/gm, '') : text);
      } else if (file === 'skill-after.json' || file === 'learning-at-handoff.json' || file === 'foreground.json')
        await copyFile(join(directory, file), join(target, file));
    }
    const transcript = await json(join(directory, 'transcript.json'));
    const validations = transcript.flatMap(s => s.events.filter(e => e.kind === 'step-completion-validation').map(e => ({ sessionId: s.session.id, ...e })));
    await writeFile(join(target, 'validation.json'), JSON.stringify(validations, null, 2) + '\n');
    const resultReads = transcript.flatMap(s => s.events.filter(e => e.plan?.tool === 'task.result.read').map(e => ({sessionId:s.session.id, input:e.plan.input, ok:e.plan.result?.ok, metadata:e.plan.result?.metadata})));
    await writeFile(join(target, 'result-reads.json'), JSON.stringify(resultReads, null, 2) + '\n');
    const receipts = transcript.flatMap(session => session.events.flatMap(event => {
      const plan = event.plan;
      if (!plan || !['terminal.run', 'process.logs'].includes(plan.tool)) return [];
      const result = plan.result ?? {}, metadata = result.metadata ?? {};
      return [{ sessionId: session.session.id, callId: plan.id, tool: plan.tool, input: plan.input,
        ok: result.ok, process: metadata.process, running: metadata.running, code: metadata.code,
        timedOut: metadata.timedOut, cancelled: metadata.cancelled,
        contentSha256: hash(result.content ?? ''), contentTail: (result.content ?? '').slice(-2500) }];
    }));
    await writeFile(join(target, 'command-receipts.json'), JSON.stringify(receipts, null, 2) + '\n');
    const learning = await json(join(directory, 'learning-learning.json.json')).then(JSON.parse).catch(() => undefined);
    const observations = await json(join(directory, 'learning-observations.jsonl.json'))
      .then(text => text.trim().split('\n').filter(Boolean).map(JSON.parse)).catch(() => []);
    const row = {
      arm, test, error: summary.error, foregroundOutcome: summary.outcome?.status, elapsedMs: summary.elapsedMs, providerCalls: summary.providerCalls,
      inputTokens: usage.reduce((n, e) => n + e.inputTokens, 0),
      outputTokens: usage.reduce((n, e) => n + e.outputTokens, 0),
      usageComplete: usage.every(e => e.usageComplete), pricingComplete: usage.every(e => e.pricingComplete),
      tasks: summary.tasks.map(({ task, steps, attempts, results }) => ({
        status: task.status,
        settlementDurationMs: task.completedAt ? Date.parse(task.completedAt) - Date.parse(task.createdAt) : undefined,
        steps: steps.map(step => ({ id: step.id, title: step.title, role: step.executor.role, status: step.status,
          tokenLimit: step.executionLimits.maxTotalTokens,
          attempts: attempts.filter(a => a.stepId === step.id).map(a => ({ status: a.status, failure: a.failure,
            providerCalls: a.usage.providerCalls, totalTokens: a.usage.totalTokens })),
          results: results.filter(r => r.stepId === step.id).map(r => ({ id: r.id, kind: r.kind, mimeType: r.mimeType, disposition: r.disposition,
            bytes: r.byteLength, sha256: r.contentHash })) }))
      })), reports, changedOriginalFixtureFiles: inputChanges,
      learning: {
        pendingHandoffs: learning?.deferredTurns?.length ?? 0,
        pendingReviews: learning?.pendingReviews?.length ?? 0,
        drafts: learning?.records.map(r => ({ status: r.draftStatus, failure: r.draftFailure, attempts: r.draftAttempts,
          proposalCreated: Boolean(r.draftProposalId) })) ?? [],
        observations: observations.map(o => ({ sessionId: o.sessionId, outcome: o.outcome,
          settledTasks: o.evidence?.settledTasks, findings: o.evidence?.findings,
          timestamp: o.timestamp }))
      }
    };
    await writeFile(join(target, 'summary.json'), JSON.stringify(row, null, 2) + '\n');
    runs.push(row);
  }
}
await writeFile(join(destination, 'summary.json'), JSON.stringify(runs, null, 2) + '\n');
console.log(`Collected ${runs.length} runs; credentials and raw session databases excluded.`);
