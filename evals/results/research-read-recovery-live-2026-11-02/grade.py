"""Grade retained live receipts; checks delivery/coverage signals, not semantic truth."""
import json,pathlib,hashlib
root=pathlib.Path(__file__).resolve().parent
read=lambda p:json.loads(p.read_text())
rows={}
for arm in ['before','after']:
 summary=read(root/arm/'summary.json');sessions=read(root/arm/'transcript.json')
 events=[e for s in sessions for e in s['events']]
 calls=[e for e in events if e['kind']=='tool-result']
 failures=[e for e in calls if e.get('result',{}).get('ok') is False]
 failed_tools=[e['tool'] for e in failures]
 corrected_git=any(e['tool']=='terminal.inspect' and e['result']['ok'] and '"-n","1"' in e.get('providerNativeToolCall',{}).get('arguments','').replace(' ','') for e in calls)
 corrected_grep=any(e['tool']=='file.grep' and e['result']['ok'] and '2M' in e.get('providerNativeToolCall',{}).get('arguments','') for e in calls)
 accepted=[r for r in summary['results'] if r['disposition']=='accepted']
 validation=[e for e in events if e['kind']=='step-completion-validation']
 rows[arm]={'status':summary['task']['status'],'steps':[(s['executor']['role'],s['status']) for s in summary['steps']],
 'failedReadTools':failed_tools,'bothSeededFailuresObserved':all(t in failed_tools for t in ['terminal.inspect','file.grep']),
 'correctedGitSucceeded':corrected_git,'correctedGrepSucceeded':corrected_grep,
 'acceptedResults':len(accepted),'diagnosticResults':len(summary['results'])-len(accepted),
 'completionValidationAccepted':sum(e.get('accepted') is True for e in validation),
 'completionValidationRejected':sum(e.get('accepted') is False for e in validation),
 'inputsUnchanged':summary['inputsUnchanged'],'providerCalls':summary['providerCalls'],
 'totalTokens':sum(u['totalTokens'] for u in read(root/arm/'usage.json')),'elapsedMs':summary['elapsedMs']}
 if arm=='before':
  rows[arm]['rejectedForToolError']=any(a.get('failure',{}).get('class')=='tool-error' for a in summary['attempts'])
  rows[arm]['rejectedDraftBytes']=max(r['byteLength'] for r in summary['results'])
 else:
  synthesis=next(s for s in summary['steps'] if s['executor']['role']=='synthesis')
  final=(root/arm/f'accepted-{synthesis["id"]}.md').read_text()
  (root/'REPORT.md').write_text(final)
  result_reads=[e for e in calls if e['tool']=='task.result.read' and e['result']['ok']]
  rows[arm]['synthesisReadBothResults']=len({e['result'].get('metadata',{}).get('resultId') for e in result_reads})==2
  rows[arm]['readLimitationReachedSynthesis']=any('Research read limitations: 2' in e['result']['content'] for e in result_reads)
  rows[arm]['reportCitesBothCodebases']='estacoda/src/tasks/agent-step-executor.ts' in final and 'hermes/tools/delegate_tool_child_run.py' in final
  rows[arm]['reportDisclosesReadFailures']='failed EstaCoda inspection attempts' in final
  rows[arm]['allAttemptsCompleted']=all(a['status']=='completed' for a in summary['attempts'])
  rows[arm]['reportBytes']=len(final.encode())
checks={
 'sameSeededErrorsAndSuccessfulCorrections':all(r[k] for r in rows.values() for k in ['bothSeededFailuresObserved','correctedGitSucceeded','correctedGrepSucceeded','inputsUnchanged']),
 'baselineReproducesRejection':rows['before']['rejectedForToolError'] and rows['before']['acceptedResults']==0 and rows['before']['completionValidationRejected']>0,
 'updatedCompletesWithBothSources':rows['after']['status']=='completed' and rows['after']['acceptedResults']==3 and rows['after']['allAttemptsCompleted'] and rows['after']['synthesisReadBothResults'] and rows['after']['reportCitesBothCodebases'],
 'limitationsSurvive':rows['after']['readLimitationReachedSynthesis'] and rows['after']['reportDisclosesReadFailures'],
 'noUpdatedValidationRepair':rows['after']['completionValidationAccepted']==3 and rows['after']['completionValidationRejected']==0,
}
result={'passed':all(checks.values()),'checks':checks,'runs':rows,'scope':'One paired real-model durable research task on curated actual source snapshots. Errors deliberately seeded. No Telegram delivery, DeepSeek end-to-end benchmark, upstream tests, repeated quality trial or measured general performance claim. Pricing unavailable; zero estimates are not zero cost.'}
(root/'comparison.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
if not result['passed']:raise SystemExit(1)
