"""Grade persisted tool receipts and Task settlement; no model calls."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent

def load(path):
    return json.loads(path.read_text())

def arm_result(root, arm):
    work = root / arm / 'work'
    skills = root / arm / 'skills'
    summary = load(work / 'summary.json')
    sessions = load(work / 'transcript.json')
    calls = []
    for session in sessions:
        for event in session['events']:
            if event['kind'] == 'tool-plan' and event['plan'].get('status') == 'executed':
                calls.append({'sessionId': session['session']['id'], 'child': bool(session['session'].get('parentSessionId')), **event['plan']})
    tests = []
    for call in calls:
        command = call.get('input', {}).get('command', '')
        if call['tool'] != 'terminal.run' or 'vitest run' not in command:
            continue
        result = call.get('result', {})
        metadata = result.get('metadata', {})
        count = re.search(r'Tests\s+(\d+) passed', result.get('content', ''))
        tests.append({'sessionId': call['sessionId'], 'child': call['child'], 'command': command,
            'ok': result.get('ok'), 'exitCode': metadata.get('code'), 'passed': int(count[1]) if count else None,
            'running': metadata.get('running'), 'timedOut': metadata.get('timedOut')})
    tasks = summary['tasks']
    steps = [step for task in tasks for step in task['steps']]
    skill_summary = load(skills / 'summary.json')
    skill_calls = []
    for session in load(skills / 'transcript.json'):
        for event in session['events']:
            if event['kind'] == 'tool-plan' and event['plan'].get('status') == 'executed' and event['plan']['tool'] == 'skill.list':
                plan = event['plan']; result = plan.get('result', {}); meta = result.get('metadata', {})
                skill_calls.append({'input': plan['input'], 'ok': result.get('ok'), 'count': meta.get('count'),
                    'totalVisible': meta.get('totalVisible'), 'names': [s['name'] for s in meta.get('skills', [])],
                    'contentFirstLine': result.get('content', '').split('\n')[0]})
    return {
        'work': {'error': summary.get('error'), 'status': [task['task']['status'] for task in tasks],
            'providerCalls': summary['providerCalls'], 'elapsedMs': summary['elapsedMs'], 'inputsUnchanged': summary['inputsUnchanged'],
            'steps': [{'role': step['executor']['role'], 'status': step['status']} for step in steps],
            'admissionFailures': [c['result']['content'] for c in calls if c['tool'] == 'delegate_task' and not c.get('result', {}).get('ok')],
            'accessPreviews': sum(c['tool'] == 'delegate_task' and c.get('input', {}).get('mode') == 'inspect' for c in calls),
            'tests': tests,
            'resultReads': [c['input'] for c in calls if c['tool'] == 'task.result.read' and c.get('result', {}).get('ok')]},
        'skills': {'error': skill_summary.get('error'), 'outcome': skill_summary.get('outcome'),
            'providerCalls': skill_summary['providerCalls'], 'elapsedMs': skill_summary['elapsedMs'],
            'inputsUnchanged': skill_summary['inputsUnchanged'], 'calls': skill_calls}
    }

comparison = {arm: arm_result(ROOT, arm) for arm in ['before', 'after']}
after = comparison['after']; work = after['work']; skills = after['skills']
comparison['checks'] = {
    'updatedTaskCompleted': work['status'] == ['completed'],
    'twoWorkersAndSynthesisAccepted': len(work['steps']) == 3 and all(s['status'] == 'completed' for s in work['steps']),
    'workersExecutedBothChecks': len({t['sessionId'] for t in work['tests'] if t['child'] and t['ok'] and t['exitCode'] == 0 and t['passed']}) == 2,
    'synthesisReadBothReports': len({str(c.get('result_id', c.get('resultId'))) for c in work['resultReads']}) >= 2,
    'sourceUnchanged': work['inputsUnchanged'] and skills['inputsUnchanged'],
    'skillsCompleted': skills['outcome']['status'] == 'completed' and skills['outcome']['terminationCause'] == 'normal',
    'blankFilterListsSkills': any(c['input'].get('category') == '' and c['count'] > 0 for c in skills['calls']),
    'missingCategoryDistinguished': any(c['input'].get('category') == '__missing_catalog_probe__' and c['count'] == 0 and c.get('totalVisible', 0) > 0 for c in skills['calls']),
}
if (ROOT / 'pilot').exists():
    comparison['pilot'] = {arm: arm_result(ROOT / 'pilot', arm) for arm in ['before', 'after']}
(ROOT / 'comparison.json').write_text(json.dumps(comparison, indent=2) + '\n')
print(json.dumps(comparison['checks'], indent=2))
raise SystemExit(0 if all(comparison['checks'].values()) else 1)
