import { it, expect } from 'vitest';
import type { SessionRecord, SessionEvent } from '../contracts/session.js';
import type { Task, TaskAttempt } from '../contracts/task.js';
import { sessionWork } from './work-projections.js';
import { taskWork, attemptWork } from './task-projections.js';
const session: SessionRecord = { id: 's', profileId: 'p', title: 'مراجعة Work', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
it('distinguishes partial, blocked, failed and cancelled outcomes from success and live ownership', () => {
  for (const [outcome, expected] of [['completed', 'completed'], ['completed_with_recovered_errors', 'completed'], ['partially_completed', 'partial'], ['blocked', 'needs_attention'], ['failed', 'failed'], ['cancelled', 'cancelled']] as const) {
    const event: SessionEvent = { kind: 'execution-final-outcome-recorded', status: outcome, terminationCause: 'normal', completionFloor: 'none' };
    expect(sessionWork(session, [event], false).status).toBe(expected);
    expect(sessionWork(session, [event], true).status).toBe('running');
  }
  expect(sessionWork(session, [], false).status).toBe('draft');
  expect(sessionWork({ ...session, endedAt: '2026-01-02' }, [], false).status).toBe('partial');
});
it('distinguishes Task waits and interrupted attempts without promoting them to completed Work', () => {
  for (const status of ['waiting_for_approval', 'waiting_for_host', 'waiting_for_input'] as const) {
    const task = { id: 't', profileId: 'p', originSessionId: 's', objective: 'Review', status, updatedAt: '2026-01-01' } as Task;
    const work = taskWork(task, new Set(['s'])); expect(work.status).toBe('needs_attention'); expect(work.parentWorkId).toBe('session:s');
    for (const attemptStatus of ['interrupted', 'expired'] as const) {
      expect(attemptWork(work, { id: 'a', attemptNumber: 2, status: attemptStatus, updatedAt: '2026-01-01' } as TaskAttempt)).toMatchObject({ parentWorkId: 'task:t', status: 'partial' });
    }
    expect(taskWork({ ...task, parentTaskId: 'parent' }, new Set(['s'])).parentWorkId).toBe('task:parent');
    expect(taskWork(task, new Set()).parentWorkId).toBeUndefined();
  }
});
