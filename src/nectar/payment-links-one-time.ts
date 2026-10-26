// A captured on-session payment becomes ordinary native charge, invoice and cash
// facts. Each stage is recoverable from the same durable capture; no stage can
// submit another charge. The owner-approved link authorizes this exact issue.
import type { Bindings } from '../auth.server'
import type { Actor } from './actor'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { canonical, commit, guard, insist, newId, one, parseJson, stmt, type Row } from './core'
import { addDays } from './dates'
import { plainMoney } from './decimal'
import { CHARGE_RATING_VERSION } from './charge-lines'
import { manualCalculation } from './manual-invoices'
import { frozenPaymentLinkTerms, linkTermsGuards, paymentLinkCaptureGuard } from './payment-links'
import { attemptGuard, paymentLinkAttemptView } from './payment-links-state'
import { allocationFactStatements, paymentFactStatement } from './receivables'

export const paymentLinkSystem=(id:string):Actor=>({id:`payment-link:${id}`,kind:'agent',name:`payment-link:${id}`,email:'',role:null,sessionId:null,capabilities:new Set(['receivables'])})

/** Internal invoice issuer's authority. Never accepted from an HTTP caller. */
export function paymentLinkInvoiceAuthority(env:Bindings,id:string) {
  return guard(env,'payment_link_authority_changed',`EXISTS(SELECT 1 FROM nc_payment_link_attempts a
    JOIN nc_payment_links l ON l.id=a.link_id JOIN nc_members m ON m.id=l.created_by
    JOIN nc_customers c ON c.id=a.customer_id JOIN nc_invoices i ON i.id=a.invoice_id AND i.customer_id=c.id
    WHERE a.id=? AND a.status='recording_invoice'
    AND json_extract(l.terms_json,'$.kind')='one_time' AND i.total_cents=json_extract(l.terms_json,'$.totalCents')
    AND json_extract(a.proof_json,'$.proof')='succeeded-payment-intent-and-captured-charge'
    AND json_extract(a.proof_json,'$.amountCents')=i.total_cents AND json_extract(a.proof_json,'$.accountRef')=l.account_ref
    AND json_extract(a.proof_json,'$.customerRef')=a.customer_ref
    AND json_extract(a.consent_json,'$.basis')=l.basis_hash
    AND json_extract(a.proof_json,'$.paymentIntentRef')=a.payment_intent_ref AND json_extract(a.proof_json,'$.chargeRef')=a.charge_ref
    AND json_extract(a.proof_json,'$.receivedOn')=i.period_start AND c.erased_at IS NULL AND c.status='active'
    AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(a.id,a.customer_id,a.invoice_id)))`,id)
}

export async function preparePaymentLinkInvoice(env:Bindings,link:Row,initial:Row) {
  let row=initial
  const terms=await frozenPaymentLinkTerms(link,row),proof=parseJson<Row>(row.proof_json,{})
  insist(terms.kind==='one_time'&&terms.oneTime&&proof.proof==='succeeded-payment-intent-and-captured-charge'
    &&proof.amountCents===terms.totalCents&&proof.accountRef===link.account_ref&&proof.customerRef===row.customer_ref
    &&proof.paymentIntentRef===row.payment_intent_ref&&proof.chargeRef===row.charge_ref,'payment_link_evidence_mismatch',409)
  const by=`agent:payment-link:${row.id}`,at=clockInstant(env)
  if(row.status==='captured') {
    const customer=newId(),charge=newId(),payment=newId(),actor=paymentLinkSystem(row.id)
    await commit(env,[attemptGuard(env,row),paymentLinkCaptureGuard(env,link,row),
      stmt(env,`INSERT INTO nc_customers(id,external_id,name,billing_email,address,language,currency,origin,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,'USD','native',?,?,?)`,customer,`PL-${row.id}`,row.name,row.billing_email,row.address,row.language,newId(),at,at),
      stmt(env,`INSERT INTO nc_charges(id,customer_id,description,quantity,unit_amount,amount_cents,currency,taxable,effective_date,pricing_evidence_json,created_by,created_at) VALUES(?,?,?,'1.00',?,?,'USD',?,?,?,?,?)`,charge,customer,terms.oneTime.description,plainMoney(terms.subtotalCents),terms.subtotalCents,terms.oneTime.taxable?1:0,proof.receivedOn,canonical({customAmountCents:terms.subtotalCents,paymentLink:link.id,attempt:row.id,owner:link.created_by,consentHash:row.consent_hash}),by,at),
      paymentFactStatement(env,actor,{paymentId:payment,customerId:customer,amountCents:proof.amountCents,currency:'USD',receivedOn:proof.receivedOn,method:'card_external',reference:`stripe:${link.account_ref}:${proof.paymentIntentRef}`,evidence:canonical({accountRef:link.account_ref,paymentIntentRef:proof.paymentIntentRef,chargeRef:proof.chargeRef,amountCents:proof.amountCents,capturedAt:proof.capturedAt,proof:proof.proof})}),
      stmt(env,`INSERT INTO nc_payment_link_attributions(id,link_id,customer_id,payment_id,status,account_ref,customer_ref,session_ref,payment_intent_ref,charge_ref,method_json,consent_hash,default_choice,created_at) VALUES(?,?,?,?,'captured',?,?,?,?,?,?,?,0,?)`,row.id,link.id,customer,payment,link.account_ref,row.customer_ref,row.session_ref,proof.paymentIntentRef,proof.chargeRef,row.method_json,row.consent_hash,at),
      stmt(env,"UPDATE nc_payment_link_attempts SET customer_id=?,payment_id=?,status='recording_invoice',revision=? WHERE id=?",customer,payment,newId(),row.id)],
      [{actor:by,action:'customer.create',subject:customer,detail:{link:link.id,attempt:row.id}},
        {actor:by,action:'charge.add',subject:charge,detail:{customer,link:link.id,amount:terms.subtotalCents}},
        {actor:by,action:'payment.record',subject:payment,detail:{customer,amount:proof.amountCents,received:proof.receivedOn,method:'card_external',reference:`stripe:${link.account_ref}:${proof.paymentIntentRef}`}},
        {actor:by,action:'payment_link.invoice.claim',subject:row.id,detail:{customer,invoice:row.invoice_id,link:link.id}}])
    row=(await one(env,'SELECT * FROM nc_payment_link_attempts WHERE id=?',row.id))!
  }
  insist(row.status==='recording_invoice','payment_link_state_changed',409)
  const existing=await one(env,'SELECT id FROM nc_invoices WHERE id=?',row.invoice_id)
  if(existing)return row
  const charges=await one(env,'SELECT id FROM nc_charges WHERE customer_id=?',row.customer_id)
  insist(charges,'payment_link_source_missing',409)
  const business=await requireBusiness(env),calculation=await manualCalculation(env,business,row.customer_id,[charges.id],proof.receivedOn)
  insist(calculation.rating.totalCents===terms.totalCents&&!calculation.rating.exceptions.length,'payment_link_terms_changed',409)
  const run=newId(),invoice=row.invoice_id,{rating,fingerprint}=calculation
  await commit(env,[attemptGuard(env,row),paymentLinkCaptureGuard(env,link,row),...linkTermsGuards(env,terms),
    guard(env,'payment_link_state_changed','NOT EXISTS(SELECT 1 FROM nc_invoices WHERE id=?)',invoice),
    guard(env,'charges_already_billed_or_missing','EXISTS(SELECT 1 FROM nc_charges WHERE id=? AND customer_id=? AND invoice_id IS NULL)',charges.id,row.customer_id),
    stmt(env,"INSERT INTO nc_bill_runs(id,period,cutoff_at,calc_version,status,summary_json,created_by,created_at,kind) VALUES(?,?,?,?,'draft',?,?,?,'manual')",run,proof.receivedOn.slice(0,7),at,CHARGE_RATING_VERSION,canonical({invoices:1,manual:true,paymentLink:link.id}),by,at),
    stmt(env,`INSERT INTO nc_invoices(id,bill_run_id,customer_id,subscription_id,invoice_kind,period_start,period_end,status,subtotal_cents,tax_cents,total_cents,currency,calc_version,source_fingerprint,calculation_json,comparison_json,exceptions_json,created_at)
      VALUES(?,?,?,NULL,'manual',?,?,'draft',?,?,?,'USD',?,?,?,'{}','[]',?)`,invoice,run,row.customer_id,proof.receivedOn,addDays(proof.receivedOn,1),rating.subtotalCents,rating.taxCents,rating.totalCents,CHARGE_RATING_VERSION,fingerprint,canonical({version:CHARGE_RATING_VERSION,fingerprint,tax:rating.tax,consumedEvents:[],inputs:calculation.input}),at),
    ...rating.lines.map((line,index)=>stmt(env,'INSERT INTO nc_invoice_lines(id,invoice_id,seq,kind,description,quantity,unit_amount,amount_cents,taxable,price_id,meter_id,period_start,period_end,evidence_json) VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)',newId(),invoice,index+1,line.kind,line.description,line.quantity,line.unitAmount,line.amountCents,line.taxable?1:0,line.priceId,line.periodStart,line.periodEnd,canonical(line.evidence)))],
    {actor:by,action:'invoice.manual',subject:invoice,detail:{link:link.id,attempt:row.id,fingerprint}})
  return row
}

export async function recordPaymentLinkCash(env:Bindings,link:Row,row:Row) {
  const terms=await frozenPaymentLinkTerms(link,row),proof=parseJson<Row>(row.proof_json,{}),actor=paymentLinkSystem(row.id),allocation=newId()
  const invoice=await one(env,"SELECT * FROM nc_invoices WHERE id=? AND status='issued' AND customer_id=?",row.invoice_id,row.customer_id)
  insist(invoice&&invoice.total_cents===proof.amountCents,'payment_link_source_missing',409)
  await commit(env,[attemptGuard(env,row),paymentLinkInvoiceAuthority(env,row.id),paymentLinkCaptureGuard(env,link,row),
    guard(env,'payment_link_evidence_mismatch',"EXISTS(SELECT 1 FROM nc_payments WHERE id=? AND customer_id=? AND amount_cents=? AND currency='USD' AND reference=?)",row.payment_id,row.customer_id,terms.totalCents,`stripe:${link.account_ref}:${proof.paymentIntentRef}`),
    ...allocationFactStatements(env,actor,row.payment_id,invoice,terms.totalCents,allocation),
    guard(env,'payment_link_evidence_mismatch',"EXISTS(SELECT 1 FROM nc_payment_link_attributions WHERE id=? AND customer_id=? AND payment_id=? AND status='captured')",row.id,row.customer_id,row.payment_id),
    stmt(env,"UPDATE nc_payment_link_attributions SET invoice_id=?,status='complete' WHERE id=?",row.invoice_id,row.id),
    stmt(env,"UPDATE nc_payment_link_attempts SET status='complete',completed_at=?,revision=? WHERE id=?",clockInstant(env),newId(),row.id),
    guard(env,'payment_link_state_changed','EXISTS(SELECT 1 FROM nc_payment_links WHERE id=? AND reserved_count>0)',link.id),stmt(env,'UPDATE nc_payment_links SET used_count=used_count+1,reserved_count=reserved_count-1 WHERE id=?',link.id)],
    [{actor:`agent:payment-link:${row.id}`,action:'payment.allocate',subject:allocation,detail:{payment:row.payment_id,invoice:invoice.number,amount:terms.totalCents}},
      {actor:`agent:payment-link:${row.id}`,action:'payment_link.complete',subject:row.id,detail:{link:link.id,customer:row.customer_id,invoice:row.invoice_id,payment:row.payment_id,owner:link.created_by,amountCents:terms.totalCents,capturedAt:proof.capturedAt}}])
  return paymentLinkAttemptView((await one(env,'SELECT * FROM nc_payment_link_attempts WHERE id=?',row.id))!)
}
