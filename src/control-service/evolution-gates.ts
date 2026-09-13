import {ALLOWED_GATES,DEFAULT_GATE_TIMEOUT_MS,normalizeGateCommand} from '../evolution/constraint-gate-runner.js';
import type {ExecutionLease} from '../execution/host-environment.js';
/** Same core gate allowlist, executed by the selected environment's process owner. */
export async function evolutionGates(lease:ExecutionLease,commands:string[],signal:AbortSignal):Promise<boolean>{
 for(const command of commands){
  signal.throwIfAborted();lease.assertActive();const argv=ALLOWED_GATES[normalizeGateCommand(command)];if(!argv)return false;
  const child=lease.processes.spawn(argv[0]!,argv.slice(1));let failed=false,bytes=0;
  const stop=()=>{failed=true;void lease.processes.terminate(child,'SIGKILL').catch(()=>{});};
  const timer=setTimeout(stop,DEFAULT_GATE_TIMEOUT_MS);signal.addEventListener('abort',stop,{once:true});
  try{const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);const consume=(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>1048576)stop();};child.stdout.on('data',consume);child.stderr.on('data',consume);});signal.throwIfAborted();if(failed||code!==0)return false;}
  finally{clearTimeout(timer);signal.removeEventListener('abort',stop);await lease.processes.terminate(child,'SIGKILL');}
 }
 return true;
}
