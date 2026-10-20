import type { Bindings } from '../auth.server'
import { requireMember, type Actor } from './actor'
import { business } from './business'
import { NectarError, all } from './core'
import { today } from './dates'
import { latestCadenceStage } from './cadence-basis'
import { currentCadencePolicy } from './cadence-policy'
import { reserveCadenceStage } from './cadence-reservations'
import { sendCadenceDelivery } from './cadence-mail'
import { clockInstant } from './clock'

/** Calendar-day offsets in the billing timezone; catch up only the most recent
 * eligible stage. Unclaimed reservations resume; claimed sends never do. */
export async function runCadences(env: Bindings, scheduledTime=clockInstant(env)) {
  const b=await business(env)
  if(!b||!(await currentCadencePolicy(env)).enabled)return {processed:0}
  const day=today(b.timezone,scheduledTime)
  const enrolled=await all(env,"SELECT e.invoice_id,i.due_date FROM nc_cadence_enrollments e JOIN nc_invoices i ON i.id=e.invoice_id JOIN nc_customers c ON c.id=i.customer_id WHERE i.status='issued' AND c.erased_at IS NULL ORDER BY i.due_date,e.invoice_id")
  let processed=0
  for(const row of enrolled) {
    const stage=latestCadenceStage(row.due_date,day)
    if(stage===null)continue
    try {
      const reservation=await reserveCadenceStage(env,row.invoice_id,stage,scheduledTime)
      if('delivery' in reservation&&reservation.delivery)await sendCadenceDelivery(env,reservation.delivery,scheduledTime)
      processed++
    }catch(error) {
      if(error instanceof NectarError&&['cadence_source_changed','cadence_already_reserved','cadence_already_claimed','already_exists','precondition_failed'].includes(error.code))continue
      throw error
    }
  }
  return {processed}
}

export async function runCadencesManually(env: Bindings, actor: Actor) {
  requireMember(actor,'receivables')
  return await runCadences(env)
}
