// Delivery custody survives request/crash boundaries. Claimed sends are never retried.
import type { Bindings } from '../auth.server'
import { operatorMail } from '../mail.server.mjs'
import { NectarError, all, commit, guard, now, one, stmt } from './core'
import { esc } from './ui/html'

export async function deliverCorrectionMail(env: Bindings, proposalId: string) {
  const row = await one(env, "SELECT m.*,EXISTS(SELECT 1 FROM nc_invoice_refunds r WHERE json_extract(r.quote_json,'$.correction.proposal.id')=m.proposal_id) AS refund_correction FROM nc_credit_correction_mail m WHERE m.proposal_id=? AND m.status='pending'", proposalId)
  if (!row) return
  try{
    await commit(env,[guard(env,'stale',"EXISTS(SELECT 1 FROM nc_credit_correction_mail m JOIN nc_proposals p ON p.id=m.proposal_id WHERE m.proposal_id=? AND m.status='pending' AND p.status='approved')",proposalId),
      stmt(env,"UPDATE nc_credit_correction_mail SET status='sending',updated_at=? WHERE proposal_id=? AND status='pending'",now(),proposalId),
      ...(row.refund_correction?[stmt(env,"UPDATE nc_credit_correction_mail SET status='suppressed',updated_at=? WHERE proposal_id=? AND status='sending' AND (NOT EXISTS(SELECT 1 FROM nc_customers WHERE id=? AND billing_email=? AND erased_at IS NULL) OR NOT EXISTS(SELECT 1 FROM nc_invoice_refunds r JOIN nc_invoice_refund_authority a ON a.refund_id=r.id WHERE json_extract(r.quote_json,'$.correction.proposal.id')=?))",now(),proposalId,row.customer_id,row.recipient,proposalId)]:[])],
      {actor:'system:invoice-credit',action:'proposal.credit.mail.claim',subject:proposalId,detail:{credit:row.credit_id,customer:row.customer_id}})
  }catch(error){if(error instanceof NectarError&&error.code==='stale')return;throw error}
  if(row.refund_correction && (await one(env,'SELECT status FROM nc_credit_correction_mail WHERE proposal_id=?',proposalId))?.status==='suppressed') {
    await commit(env,[],{actor:'system:invoice-credit',action:'proposal.credit.mail.delivery',subject:proposalId,detail:{status:'suppressed',provider:null,reason:'refund_recipient_changed'}})
    return {status:'suppressed',providerRef:null}
  }
  let status = 'failed', provider: string | null = null
  try {
    const mail = operatorMail(env)
    if (mail && env.MAIL_FROM) {
      // Network entry marks the outcome uncertain until the provider answers.
      status = 'uncertain'
      const result = await mail.send({ deliveryId: `invoice-credit-${proposalId}`, from: env.MAIL_FROM, to: [row.recipient],
        subject: row.subject, text: row.body, html: `<pre>${esc(row.body)}</pre>`, headers: { 'Auto-Submitted': 'auto-generated' } })
      status = result.status === 'accepted' ? 'accepted' : result.status === 'development' ? 'suppressed' : ['failed','rejected','rate_limited'].includes(result.status) ? 'failed' : 'uncertain'
      provider = result.providerMessageId ?? null
    }
  } catch { /* A network error cannot prove that the provider rejected the mail. */ }
  await commit(env, [stmt(env, "UPDATE nc_credit_correction_mail SET status=?,provider_ref=?,updated_at=? WHERE proposal_id=? AND status='sending'", status, provider, now(), proposalId)],
    { actor: 'system:invoice-credit', action: 'proposal.credit.mail.delivery', subject: proposalId, detail: { status, provider } })
  return { status, providerRef: provider }
}

/** Resume only mail never claimed; sending/uncertain/failed mail is not retried. */
export async function deliverPendingCorrectionMail(env: Bindings) {
  const rows = await all(env, "SELECT proposal_id FROM nc_credit_correction_mail WHERE status='pending' ORDER BY created_at,proposal_id LIMIT 100")
  for (const row of rows) await deliverCorrectionMail(env, row.proposal_id)
}
