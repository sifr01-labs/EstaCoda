import type {RuntimeCounts} from '../contracts/desktop-control/index.js';
import type {WorkState} from './work-snapshot.js';
/** Counts canonical Work, not OS commands or active provider calls. Attempts are not counted twice. */
export function workCounts(state:WorkState):RuntimeCounts{
 const work=state.work,inbox=state.inbox??[];
 return{runningSessions:work.filter(item=>item.kind==='session'&&!item.parentWorkId&&item.status==='running').length,
 runningTasks:work.filter(item=>item.kind==='task'&&item.status==='running').length,
 queuedTasks:work.filter(item=>item.kind==='task'&&item.status==='queued').length,
 approvals:inbox.filter(item=>item.kind==='approval').length,attention:inbox.length,scheduled:state.activeSchedules??null,asOf:state.capturedAt??Date.now()};
}
