import type { Bindings } from '../auth.server'
import { operatorMail } from '../mail.server.mjs'
import { NectarError, commit, guard, now, one, stmt } from './core'
import { esc } from './ui/html'
import { cadenceBasis } from './cadence-basis'
import { cadenceSourceGuard, cadenceSourceSequence } from './cadence-policy'
import { clockInstant } from './clock'

/** Claim once, then make one provider call. An interrupted claim or uncertain
 * result never retries automatically, even after the provider's dedupe expires. */
export async function sendCadenceDelivery(env: Bindings, id: string, instant=clockInstant(env)) {
  const seq=await cadenceSourceSequence(env)
  const row=await one(env,'SELECT * FROM nc_cadence_deliveries WHERE id=?',id)
  if(!row||row.status!=='pending')return
  const basis=await cadenceBasis(env,row.invoice_id,row.stage,instant)
  if(basis.reason||basis.basisKey!==row.basis_key)return
  try {
    await commit(env,[cadenceSourceGuard(env,seq),guard(env,'cadence_already_claimed',"EXISTS(SELECT 1 FROM nc_cadence_deliveries WHERE id=? AND status='pending' AND claimed_at IS NULL)",id),
      stmt(env,"UPDATE nc_cadence_deliveries SET status='sending',claimed_at=? WHERE id=?",now(),id)],
      {actor:'system:cadences',action:'cadence.mail.claim',subject:id,detail:{invoice:row.invoice_id,stage:row.stage,deliveryId:`cadence-${id}`,basis:row.basis_key,approval:row.approval_mode,approvedBy:row.approved_by}})
  }catch(error) {
    if(error instanceof NectarError&&['cadence_source_changed','cadence_already_claimed','precondition_failed'].includes(error.code))return
    throw error
  }
  let status='failed',provider:string|null=null
  try {
    const mail=operatorMail(env)
    if(mail&&env.MAIL_FROM) {
      status='uncertain'
      const result=await mail.send({deliveryId:`cadence-${id}`,from:env.MAIL_FROM,to:[row.recipient],subject:row.subject,
        text:row.body,html:`<pre style="white-space:pre-wrap;font:16px/1.5 sans-serif">${esc(row.body)}</pre>`,headers:{'Auto-Submitted':'auto-generated'}})
      status=result.status==='development'?'suppressed':result.status
      provider=result.providerMessageId??null
    }
  }catch { /* A send may have reached the provider. Preserve the uncertainty. */ }
  await commit(env,[guard(env,'cadence_outcome_changed',"EXISTS(SELECT 1 FROM nc_cadence_deliveries WHERE id=? AND status='sending')",id),
    stmt(env,'UPDATE nc_cadence_deliveries SET status=?,provider_ref=?,finished_at=? WHERE id=?',status,provider,now(),id)],
    {actor:'system:cadences',action:'cadence.mail.outcome',subject:id,detail:{invoice:row.invoice_id,stage:row.stage,status,provider,deliveryId:`cadence-${id}`}})
  return {delivery:id,status,provider}
}
