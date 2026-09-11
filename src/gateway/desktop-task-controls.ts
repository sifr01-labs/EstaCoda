import type { PrivateControlRequest } from '../contracts/control-protocol.js';
import type { TaskStore } from '../tasks/task-store.js';
import { TaskOperatorService } from '../tasks/task-operator-service.js';
import { FixedTaskService } from '../tasks/fixed-task-service.js';
/** Runs inside the supervisor. Authorization and target checks precede synchronous core mutations. */
export function desktopTaskControl(store: TaskStore, request: PrivateControlRequest): { taskId: string } {
  const task = request.taskId ? store.getTask(request.taskId) : null;
  if (!task || task.executionTarget?.targetId !== request.targetId || task.executionTarget.targetGeneration !== request.targetGeneration ||
    task.originSessionId !== request.sessionId) throw new Error('Task control binding does not match.');
  const service = new TaskOperatorService({ store });
  switch (request.method) {
    case 'task.pause': service.pause(task.id, request.sessionId); break;
    case 'task.resume': service.resume(task.id, request.sessionId); break;
    case 'task.cancel': service.cancel(task.id, request.sessionId); break;
    case 'task.retry': service.retry(task.id, request.stepId, request.sessionId); break;
    case 'task.guide': new FixedTaskService({ store }).steer({ taskId: task.id, authorizedSessionId: request.sessionId, guidance: request.guidance! }); break;
    default: throw new Error('Unknown Task control.');
  }
  return { taskId: task.id };
}
