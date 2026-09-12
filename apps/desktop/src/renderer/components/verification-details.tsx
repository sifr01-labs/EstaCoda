import {useI18n} from '../i18n.js';
import type{CandidateVerification}from'@estacoda/control-protocol';
/** Service-projected measurements only. A missing price is never displayed as zero. */
export function VerificationDetails({result}:{result:CandidateVerification}){
 const {t,owned,status}=useI18n();
 const rows=[[t("Result"),result.reason==='none'?t("Complete"):status(result.reason??"unknown")],[t("Streaming"),result.streaming===true?t("Observed"):t("Not confirmed")],[t("Tool compatibility"),result.tools===true?t("Observed"):t("Not confirmed")],[t("Latency"),result.latencyMs===undefined?t("Unavailable"):result.latencyMs+' ms'],[t("Reported input / output tokens"),`${result.inputTokens??t("Unavailable")} / ${result.outputTokens??t("Unavailable")}`],[t("Estimated test cost"),result.estimatedCost==null?t("Unavailable"):result.estimatedCost.toFixed(8)+' USD']];
 return <dl aria-label={t("Verification details")}>{rows.map(([name,value])=><div className="ec-kv" key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>;
}
