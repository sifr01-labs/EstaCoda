import type {SessionRecord} from '../contracts/session.js';
import type {Task, TaskAttempt, TaskResult} from '../contracts/task.js';

export type ArtifactWorkLinks = {sessionId: string; taskId?: string; attemptId?: string; workIds: string[]};
/** Canonical records, never caller supplied links, determine profile ownership. */
export function sessionArtifactLinks(profileId: string, session: SessionRecord, task?: Task, attempt?: TaskAttempt): ArtifactWorkLinks {
  if (session.profileId !== profileId) throw new Error('Artifact owner unavailable.');
  const workIds = [`session:${session.id}`];
  if (task && (task.profileId !== profileId || !attempt || attempt.profileId !== profileId || attempt.taskId !== task.id || attempt.workerSessionId !== session.id)) throw new Error('Artifact task link unavailable.');
  if (task && attempt) workIds.push(`attempt:${attempt.id}`, `task:${task.id}`);
  return {sessionId: session.id, ...(task && attempt ? {taskId:task.id, attemptId:attempt.id} : {}), workIds};
}
export function taskArtifactLinks(profileId: string, task: Task, result: TaskResult, attempt?: TaskAttempt): ArtifactWorkLinks {
  if (task.profileId !== profileId || result.profileId !== profileId || result.taskId !== task.id ||
      (result.attemptId && (!attempt || attempt.id !== result.attemptId || attempt.profileId !== profileId || attempt.taskId !== task.id))) throw new Error('Result owner unavailable.');
  return {sessionId:task.originSessionId, taskId:task.id, ...(attempt ? {attemptId:attempt.id} : {}),
    workIds:[...(attempt ? [`attempt:${attempt.id}`] : []), `task:${task.id}`, `session:${task.originSessionId}`]};
}
