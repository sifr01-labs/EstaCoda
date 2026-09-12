import type{CandidateVerification}from'@estacoda/control-protocol';
/** Service-projected measurements only. A missing price is never displayed as zero. */
export function VerificationDetails({result}:{result:CandidateVerification}){
 const rows=[['Result',result.reason==='none'?'Complete':result.reason?.replaceAll('_',' ')??'Unavailable'],['Streaming',result.streaming===true?'Observed':'Not confirmed'],['Tool compatibility',result.tools===true?'Observed':'Not confirmed'],['Latency',result.latencyMs===undefined?'Unavailable':result.latencyMs+' ms'],['Reported input / output tokens',`${result.inputTokens??'Unavailable'} / ${result.outputTokens??'Unavailable'}`],['Estimated test cost',result.estimatedCost==null?'Unavailable':result.estimatedCost.toFixed(8)+' USD']];
 return <dl aria-label="Verification details">{rows.map(([name,value])=><div className="ec-kv" key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>;
}
