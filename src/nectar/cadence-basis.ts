import type { Bindings } from '../auth.server'
import { canonical, one } from './core'
import { daysBetween } from './dates'
import { customerText } from './locale'
import { collectibleInvoice } from './cadence-holds'
import { currentCadencePolicy } from './cadence-policy'
import { clockInstant } from './clock'

export const CADENCE_STAGES = [-3,1,7,15] as const
export const latestCadenceStage = (due: string, day: string) => CADENCE_STAGES.filter(stage=>daysBetween(due,day)>=stage).at(-1)??null

/** Exact source and wording frozen before approval. Templates cannot override
 * the appended collectible amount or conceal excluded disputed cents. */
export async function cadenceBasis(env: Bindings, invoiceId: string, stage: number, instant=clockInstant(env)) {
  const invoice=await collectibleInvoice(env,invoiceId,instant)
  const enrollment=await one(env,'SELECT * FROM nc_cadence_enrollments WHERE invoice_id=?',invoiceId)
  const policy=await currentCadencePolicy(env)
  const ruleIndex=policy.rules.findIndex(rule=>rule.segment===enrollment?.segment&&invoice.collectibleCents>=rule.minimum_cents)
  const rule=policy.rules[ruleIndex]
  const latest=latestCadenceStage(invoice.due_date,invoice.day)
  const recipient=String(invoice.billing_email??'').trim().toLowerCase()
  const reason=!enrollment?'not_enrolled':!policy.enabled?'policy_disabled':invoice.hold??
    (ruleIndex<0?'no_matching_rule':!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)?'invalid_recipient':latest!==stage?'stage_not_current':null)
  // Owner-authored rule text is sent as written; Nectar's own facts follow the customer's language.
  const L=customerText(invoice.language)
  const values: Record<string,string>={invoice:invoice.number,balance:L.money(invoice.collectibleCents),stage:String(stage),business:invoice.business.legal_name}
  const render=(text:string)=>text.replace(/\{(invoice|balance|stage|business)\}/g,(_,key:string)=>values[key])
  const subject=rule?render(rule.subject):''
  const excluded=invoice.disputes.map(row=>L.t('cadence.dispute',{dispute:row.id,line:row.line_id,amount:L.money(row.amount_cents)})).join('\n')
  const facts=`${L.t('cadence.due',{invoice:invoice.number,date:L.day(invoice.due_date)})}\n${L.t('cadence.requested',{amount:L.money(invoice.collectibleCents)})}${excluded?`\n${excluded}`:''}`
  const body=rule?`${render(rule.body)}\n\n${facts}`:''
  const source={invoice:invoiceId,sourceFingerprint:invoice.source_fingerprint,holdBasis:invoice.basis,
    enrollment,policyRevision:policy.revision,ruleIndex,rule:rule??null,stage,recipient,business:invoice.business.legal_name,timezone:invoice.business.timezone}
  const basisKey=canonical({source,recipient,subject,body})
  return {invoice,enrollment,policy,ruleIndex,stage,latest,recipient,subject,body,source,basisKey,reason}
}
