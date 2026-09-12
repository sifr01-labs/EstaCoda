import {randomUUID} from 'node:crypto';
export type BrowserControlLease={id:string;generation:number};
/** Runtime-owned, monotonic lease. Expiry fences input but NEVER resumes the agent. */
export class BrowserControlOwner {
 readonly #instance=randomUUID();#generation=0;#phase:'agent'|'human'|'paused'|'closed'='agent';
 #lease?:BrowserControlLease;#holder?:string;#deadline=0;#busy=0;#sequence=0;
 constructor(readonly now:()=>number=()=>performance.now(),readonly ttlMs=10_000){}
 #expire(){if(this.#phase==='human'&&this.now()>=this.#deadline){this.#phase='paused';this.#lease=undefined;this.#holder=undefined;this.#generation++;}}
 agentSync<T>(operation:()=>T):T{this.#expire();if(this.#phase!=='agent')throw new Error('Browser agent actions paused for human control.');this.#busy++;try{return operation();}finally{this.#busy--;}}
 async agent<T>(operation:()=>Promise<T>):Promise<T>{this.#expire();if(this.#phase!=='agent')throw new Error('Browser agent actions paused for human control.');this.#busy++;try{return await operation();}finally{this.#busy--;}}
 acquire(holder:string):BrowserControlLease{
  this.#expire();if(this.#phase==='closed'||this.#busy||this.#phase==='human')throw new Error('Browser control is busy or already owned.');
  this.#phase='human';this.#holder=holder;this.#sequence=0;this.#deadline=this.now()+this.ttlMs;
  this.#lease={id:this.#instance,generation:++this.#generation};return{...this.#lease};
 }
 #assert(holder:string,lease:BrowserControlLease){this.#expire();if(this.#phase!=='human'||this.#holder!==holder||lease.id!==this.#lease?.id||lease.generation!==this.#lease.generation)throw new Error('Browser control lease is stale.');}
 verify(holder:string,lease:BrowserControlLease){this.#assert(holder,lease);}
 renew(holder:string,lease:BrowserControlLease){this.#assert(holder,lease);this.#deadline=this.now()+this.ttlMs;}
 async human<T>(holder:string,lease:BrowserControlLease,sequence:number,operation:()=>Promise<T>):Promise<T>{
  this.#assert(holder,lease);if(this.#busy||!Number.isSafeInteger(sequence)||sequence!==this.#sequence+1)throw new Error('Concurrent or replayed browser input.');
  this.#sequence=sequence;this.#busy++;
  try{const result=await operation();this.#assert(holder,lease);return result;}
  catch(error){if(this.#phase!=='closed'){this.#phase='paused';this.#lease=undefined;this.#holder=undefined;this.#generation++;}throw error;}
  finally{this.#busy--;}
 }
 release(holder:string,lease:BrowserControlLease){this.#assert(holder,lease);if(this.#busy)throw new Error('Browser input is still settling.');this.#lease=undefined;this.#holder=undefined;this.#generation++;this.#phase='agent';}
 close(){this.#phase='closed';this.#lease=undefined;this.#holder=undefined;this.#generation++;}
}
