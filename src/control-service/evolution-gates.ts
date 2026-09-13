import {evolutionToolchain} from './evolution-toolchain.js';
import {ALLOWED_GATES,DEFAULT_GATE_TIMEOUT_MS,normalizeGateCommand} from '../evolution/constraint-gate-runner.js';
import type {ExecutionLease} from '../execution/host-environment.js';
/** Same core gate allowlist, executed by the selected environment's process owner. */
export async function evolutionGates(lease:ExecutionLease,commands:string[],signal:AbortSignal):Promise<boolean>{
 signal.throwIfAborted();lease.assertActive();if(!commands.length)return true;
 if(commands.some(command=>!ALLOWED_GATES[normalizeGateCommand(command)]))return false;
 const toolchain=lease.facts.backend==='host'?await evolutionToolchain().catch(()=>undefined):undefined;
 if(lease.facts.backend==='host'&&!toolchain)return false;
 for(const command of commands){
  signal.throwIfAborted();lease.assertActive();const argv=ALLOWED_GATES[normalizeGateCommand(command)];if(!argv)return false;
  const child=lease.processes.spawn(toolchain?.command??argv[0]!,[...(toolchain?.args??[]),...argv.slice(1)],{env:{...lease.processes.environment(),...(toolchain?{PATH:toolchain.path}:{}),COREPACK_ENABLE_NETWORK:'0',COREPACK_ENABLE_PROJECT_SPEC:'0',npm_config_manage_package_manager_versions:'false'}});let failed=false,bytes=0;
  const stop=()=>{failed=true;void lease.processes.terminate(child,'SIGKILL').catch(()=>{});};
  const timer=setTimeout(stop,DEFAULT_GATE_TIMEOUT_MS);signal.addEventListener('abort',stop,{once:true});
  try{const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);const consume=(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>1048576)stop();};child.stdout.on('data',consume);child.stderr.on('data',consume);});signal.throwIfAborted();if(failed||code!==0)return false;}
  finally{clearTimeout(timer);signal.removeEventListener('abort',stop);await lease.processes.terminate(child,'SIGKILL');}
 }
 return true;
}
