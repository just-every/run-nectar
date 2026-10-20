// Customer requests use the ordinary immutable AGENT-002 proposal and human
// decision door. The preparer remains a customer, with no operator Actor.
import type { Bindings } from '../auth.server'
import type { CustomerSession } from './portal-session'
import { billingAnswer } from './billing-answers'
import { all, commit, guard, insist, newId, now, one, parseJson, stmt, type Row } from './core'
import { clockInstant } from './clock'
import type { Input } from './input'
import { Input as Fields } from './input'
import { alertStatements } from './notifications'
import { deliverAlerts } from './notification-mail'
import { customerText } from './locale'
import { h } from './ui/html'

export async function portalProposeCredit(env: Bindings, session: CustomerSession, input: Input) {
  input.only(['invoice','question','topic','credit_amount','reason'])
  const fields=Object.fromEntries(['invoice','question','topic','credit_amount','reason'].filter(key=>input.has(key)).map(key=>[key,input.text(key,{optional:true,max:1000})]))
  const answer=await billingAnswer(env,session,Fields.of({...fields,customer:session.customer}))
  insist(answer.proposalDraft,'credit_request_required')
  const draft=answer.proposalDraft,id=newId(),by=`customer:portal:${session.customer}`
  const {planInvoiceCredit}=await import('./credit-correction')
  const {requireBusiness}=await import('./business')
  const prepared=await planInvoiceCredit(env,await requireBusiness(env),draft.payload)
  await commit(env,[
    guard(env,'invalid_customer_session',`EXISTS(SELECT 1 FROM nc_portal_sessions s JOIN nc_customers c ON c.id=s.customer_id JOIN nc_portal_policy p ON p.singleton=1 AND p.revision=s.policy_revision WHERE s.id=? AND s.customer_id=? AND s.revoked_at IS NULL AND s.expires_at>? AND c.erased_at IS NULL)`,session.jti,session.customer,clockInstant(env)),
    ...await alertStatements(env,'proposals',id,`/app/proposals/${id}`),
    stmt(env,`INSERT INTO nc_proposals(id,kind,title,payload_json,evidence_json,impact_json,basis_json,status,created_by,created_by_kind,created_at,prepared_by_id) VALUES(?,'amendment',?,?,?,?,?,'pending',?,'customer',?,NULL)`,id,draft.title,JSON.stringify(prepared.normalized),'{}',JSON.stringify(prepared.impact),JSON.stringify(prepared.basis),by,now()),
  ],{actor:by,action:'proposal.create',subject:id,detail:{kind:'amendment',customer:session.customer}})
  await deliverAlerts(env,'proposals',id,by)
  return {id,status:'pending'}
}

export async function portalCreditProposal(env: Bindings,session:CustomerSession,id:string){
  const row=await one(env,`SELECT p.id,p.status,p.payload_json,p.impact_json FROM nc_proposals p JOIN nc_invoices i ON i.id=json_extract(p.payload_json,'$.invoice') WHERE p.id=? AND p.created_by_kind='customer' AND p.created_by=? AND i.customer_id=? AND i.status='issued' AND json_extract(p.payload_json,'$.invoice_credit')=1`,id,`customer:portal:${session.customer}`,session.customer)
  insist(row,'not_found',404)
  const payload=parseJson<Row>(row.payload_json,{}),impact=parseJson<Row>(row.impact_json,{})
  return {id:row.id,status:row.status,invoice:payload.invoice,reason:payload.reason,explanation:payload.explanation,amountCents:impact.credit.amountCents,balanceBeforeCents:impact.credit.balanceBeforeCents,balanceAfterCents:impact.credit.balanceAfterCents}
}

export function portalCreditProposalPage(session:CustomerSession,proposal:Awaited<ReturnType<typeof portalCreditProposal>>,link:(path:string)=>string){
  const L=customerText(session.language)
  return h`<h1>${L.t('portal.answer.proposal')}</h1><p>${L.t(`portal.answer.status.${proposal.status}`)}</p><p>${proposal.reason}</p><p>${proposal.explanation}</p><dl><dt>${L.t('portal.answer.requested')}</dt><dd>${L.money(proposal.amountCents)}</dd><dt>${L.t('portal.answer.figure.owed')}</dt><dd>${L.money(proposal.balanceBeforeCents)} → ${L.money(proposal.balanceAfterCents)}</dd></dl><p><a href="${link(`/portal/invoices/${proposal.invoice}`)}">${L.t('portal.back')}</a></p>`
}
