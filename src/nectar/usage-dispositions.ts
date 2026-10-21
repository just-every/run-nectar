import { customerText } from './locale'
// A correction is reviewed against a complete, immutable issued chain. Only
// approval appends an effective basis and settles/queues its exact signed delta.
import type { Bindings } from '../auth.server'
import { actorLabel, requireCapability, requireMember, requireOwner, type Actor } from './actor'
import { all, canonical, commit, fingerprint, guard, insist, newId, now, one, parseJson, stmt, type Row } from './core'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { creditPolicy } from './credit-policy'
import { documentNumberAllocation } from './invoice-numbering'
import { addDays, localDate } from './dates'
import { Input } from './input'
import { requireFreshFactor } from './mfa'
import { preparePolicyChange } from './policy-changes'
import { previewUsageCorrection } from './usage-replay'
import { recognitionForRating } from './revenue-allocation'
import { revenuePeriodDeltas, revenuePreview } from './draft-correction-plan'
import { rate, type Line, type RatingInput } from './rating'
import { BALANCE_SQL } from './receivables'
import { invoiceContent } from './invoice-content'
import { deliverUsageCorrectionMail } from './usage-disposition-mail'
import { carriedUsageCredits } from './usage-correction-records'
import type { UsageAdjustment } from './usage-correction-records'

export const DISPOSITIONS = ['next_invoice','correcting_invoice','credit_note'] as const
export async function configureUsagePolicy(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  await requireFreshFactor(env,actor)
  const disposition = input.text('disposition',{max:30})
  insist(DISPOSITIONS.includes(disposition as typeof DISPOSITIONS[number]),'invalid_usage_disposition')
  return preparePolicyChange(env,actor,'usage',{disposition})
}
const sequence = async (env: Bindings) => (await one(env,'SELECT COALESCE(MAX(seq),0) AS value FROM nc_audit'))!.value as number
const sequenceGuard = (env: Bindings, seq: number) => guard(env,'correction_source_changed','(SELECT COALESCE(MAX(seq),0) FROM nc_audit)=?',seq)

async function plan(env: Bindings, actor: Actor, payload: Row) {
  const seq = await sequence(env)
  const b = await requireBusiness(env)
  const replay = await previewUsageCorrection(env,actor,Input.of(payload))
  insist(replay.voidEventIds.length+replay.addEventIds.length>0,'correction_required')
  const sub = await one(env,"SELECT * FROM nc_subscriptions WHERE id=? AND billing_mode='live'",replay.subscription)
  insist(sub,'live_subscription_required',409)
  const [customer,policy,credit,latest,privacy] = await Promise.all([
    one(env,'SELECT * FROM nc_customers WHERE id=? AND erased_at IS NULL',sub.customer_id),
    one(env,'SELECT * FROM nc_usage_policy WHERE singleton=1'), creditPolicy(env),
    one(env,"SELECT period_start FROM nc_invoices WHERE subscription_id=? AND invoice_kind='recurring' AND status='issued' ORDER BY period_start DESC LIMIT 1",sub.id),
    one(env,'SELECT value FROM nc_privacy_generation WHERE id=1'),
  ])
  const selected=[...replay.voidEventIds,...replay.addEventIds],dates:number[]=[]
  for(let n=0;n<selected.length;n+=80){const ids=selected.slice(n,n+80);dates.push(...(await all(env,`SELECT occurred_at FROM nc_usage_events WHERE event_id IN (${ids.map(()=>'?').join(',')})`,...ids)).map(row=>row.occurred_at))}
  const earliest=localDate(Math.min(...dates),replay.periods[0].beforeInput.timezone)
  insist(replay.periods[0].period.start<=(earliest<sub.start_date?sub.start_date:earliest),'complete_upstream_replay_required',409)
  insist(customer && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.billing_email),'customer_billing_email_required',409)
  insist(latest && replay.periods.at(-1)!.period.start===latest.period_start,'complete_downstream_replay_required',409)
  insist(policy && privacy,'correction_policy_required',409)
  const issueDate=localDate(clockInstant(env),b.timezone)
  insist(!payload.issue_date || payload.issue_date===issueDate,'correction_date_changed',409)
  const reason=String(payload.reason??'').trim(), explanation=String(payload.explanation??'').trim()
  insist(reason.length>0&&reason.length<=500,'correction_reason_required')
  insist(explanation.length>0&&explanation.length<=8000,'correction_explanation_required')
  const normalized={subscription:sub.id,from_period:replay.fromPeriod,through_period:replay.throughPeriod,void_event_ids:replay.voidEventIds,add_event_ids:replay.addEventIds,reason,explanation,issue_date:issueDate,correction_id:payload.correction_id}
  const periods=[]
  for(const p of replay.periods){
    // Reject a newly introduced blocking rating error rather than silently
    // settling a zero charge for invalid negative metrics or missing history.
    insist(!p.after.exceptions.some(e=>['metric_negative_quantity','metric_duplicate_selection','commitment_prior_periods'].includes(e.code)),'correction_replay_blocked',409,p.after.exceptions)
    const [beforeRevenue,afterRevenue,balance]=await Promise.all([
      revenuePreview(recognitionForRating(p.beforeInput,p.before)),revenuePreview(recognitionForRating(p.afterInput,p.after)),
      one(env,`SELECT ${BALANCE_SQL} AS value FROM nc_invoices i WHERE i.id=?`,p.invoice),
    ])
    const revenue= revenuePeriodDeltas(beforeRevenue,afterRevenue)
    insist(revenue.reduce((n,e)=>n+e.deltaCents,0)===p.deltaSubtotalCents,'correction_revenue_mismatch',409)
    const creditCents=Math.max(0,-p.deltaTotalCents),appliedCents=policy.disposition==='next_invoice'?0:Math.min(creditCents,Math.max(0,balance!.value))
    periods.push({invoice:p.invoice,number:p.number,period:p.period,version:p.version,originalFingerprint:p.originalFingerprint,fingerprint:p.fingerprint,
      before:{subtotalCents:p.before.subtotalCents,taxCents:p.before.taxCents,totalCents:p.before.totalCents},
      after:{subtotalCents:p.after.subtotalCents,taxCents:p.after.taxCents,totalCents:p.after.totalCents},
      subtotalCents:p.deltaSubtotalCents,taxCents:p.deltaTaxCents,totalCents:p.deltaTotalCents,
      beforeLines:p.before.lines.map(l=>({description:l.description,amountCents:l.amountCents})),afterLines:p.after.lines.map(l=>({description:l.description,amountCents:l.amountCents})),eventIds:p.eventIds,revenue,postingRevenue: p.deltaTotalCents<0?[{period:issueDate.slice(0,7),amountCents:p.deltaSubtotalCents,method:'credit-contra-issue-month'}]:revenue.filter(e=>e.deltaCents!==0).map(e=>({period:e.period,amountCents:e.deltaCents,method:'historical-usage-replay-delta'})),balanceCents:balance!.value,creditCents,appliedCents,carriedCents:creditCents-appliedCents})
  }
  const availableCredits=await carriedUsageCredits(env,customer.id)
  const creditCents=periods.reduce((n,p)=>n+p.creditCents,0)
  const L=customerText(customer.language)
  const summary={availableCredits,timezone:b.timezone,subscription:sub.id,customer:customer.id,recipient:customer.billing_email,language:customer.language,disposition:policy.disposition,policyRevision:policy.revision,
    creditPolicyRevision:credit.revision,thresholdCents:credit.two_person_above_cents,issueDate,reason,explanation,periods,delta:replay.delta,
    creditCents,carriedCents:periods.reduce((n,p)=>n+p.carriedCents,0),needsSecondApprover:credit.two_person_above_cents!==null&&creditCents>credit.two_person_above_cents,
    // These are the exact authored words, followed by machine-calculated source
    // citations. The author writes in the customer's language; no translation.
    message:{recipient:customer.billing_email,subject:L.t('usageCorrection.subject'),body:explanation+'\n\n'+periods.map(p=>L.t('usageCorrection.period',{
      number:p.number,from:L.day(p.period.start),to:L.day(p.period.end),subtotal:L.money(p.subtotalCents),tax:L.money(p.taxCents),total:L.money(p.totalCents),
      source:`/portal/invoices/${p.invoice}`,fingerprint:p.fingerprint,revenue:p.postingRevenue.map(r=>`${r.period}: ${L.money(r.amountCents)} (${L.t(r.method==='credit-contra-issue-month'?'usageCorrection.creditRevenue':'usageCorrection.replayRevenue')})`).join(', ')
    })).join('\n')+'\n'+L.t('usageCorrection.footer',{policy:L.t('usageCorrection.'+policy.disposition),receipt:`/portal/corrections/${payload.correction_id}`})}}

  const basis=await fingerprint({summary,subRevision:sub.revision,customerRevision:customer.revision,invoiceSettings:customer.invoice_settings_json,
    credit,policy,replayFingerprint:replay.fingerprint})
  insist(await sequence(env)===seq,'correction_source_changed',409)
  return {seq,normalized,summary,basis,replay,customer,business:b}
}

export async function prepareUsageCorrection(env: Bindings, actor: Actor, input: Input) {
  requireCapability(actor,'propose')
  const id=newId()
  const payload={correction_id:id,subscription:input.text('subscription',{max:100}),from_period:input.text('from_period',{max:7}),through_period:input.text('through_period',{max:7}),
    void_event_ids:input.has('void_ids')?input.text('void_ids',{max:1500000}).split(/\s+/).filter(Boolean):input.list('void_event_ids'),add_event_ids:input.has('add_ids')?input.text('add_ids',{max:1500000}).split(/\s+/).filter(Boolean):input.list('add_event_ids'),reason:input.text('reason',{max:500}),explanation:input.text('explanation',{max:8000})}
  const p=await plan(env,actor,payload)
  await commit(env,[sequenceGuard(env,p.seq),stmt(env,`INSERT INTO nc_usage_corrections(id,subscription_id,customer_id,payload_json,plan_json,basis,prepared_by_id,prepared_by_kind,prepared_by,prepared_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    id,p.summary.subscription,p.summary.customer,JSON.stringify(p.normalized),JSON.stringify(p.summary),p.basis,actor.id,actor.kind,actorLabel(actor),now())],
    {actor:actorLabel(actor),action:'usage.correction.prepare',subject:id,detail:{subscription:p.summary.subscription,basis:p.basis,delta:p.summary.delta,disposition:p.summary.disposition}})
  return {id,status:'pending',basis:p.basis,plan:p.summary}
}
async function checked(env: Bindings, actor: Actor, id: string) {
  const row=await one(env,'SELECT * FROM nc_usage_corrections WHERE id=?',id)
  insist(row,'correction_not_found',404);insist(row.status==='pending','correction_already_decided',409)
  const p=await plan(env,actor,parseJson<Row>(row.payload_json,{}))
  insist(p.basis===row.basis,'correction_stale',409)
  return {row,p}
}
export async function authorizeUsageCorrection(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor,'approve');await requireFreshFactor(env,actor)
  const {row,p}=await checked(env,actor,input.text('correction',{max:100}))
  await commit(env,[sequenceGuard(env,p.seq),guard(env,'correction_already_decided',"EXISTS(SELECT 1 FROM nc_usage_corrections WHERE id=? AND status='pending' AND authorized_by_id IS NULL)",row.id),
    stmt(env,'UPDATE nc_usage_corrections SET authorized_by_id=?,authorized_basis=? WHERE id=?',actor.id,row.basis,row.id)],
    {actor:actorLabel(actor),action:'usage.correction.authorize',subject:row.id,detail:{basis:row.basis,creditCents:p.summary.creditCents}})
  return {id:row.id,status:'pending',authorizedBy:actor.id}
}

function adjustmentLine(p: Row, correction: string): Line {
  const revenue=p.revenue.filter((e:Row)=>e.deltaCents!==0)
  if(!revenue.length)revenue.push({period:p.period.start.slice(0,7),deltaCents:0})
  return {kind:'usage_correction',description:`Historical usage correction · ${p.number} · ${p.period.start} to ${p.period.end}`,
    quantity:'1',unitAmount:'',amountCents:p.subtotalCents,taxable:false,priceId:null,meterId:null,periodStart:p.period.start,periodEnd:p.period.end,
    evidence:{correction,originalInvoice:p.invoice,originalNumber:p.number,originalFingerprint:p.originalFingerprint,replayFingerprint:p.fingerprint,eventIds:p.eventIds,
      taxDeltaCents:p.taxCents,revenueEntries:revenue.map((e: Row)=>({period:e.period,amountCents:e.deltaCents,basis:{method:'historical-usage-replay-delta',correction,originalInvoice:p.invoice,replayFingerprint:p.fingerprint}}))}}
}

export async function decideUsageCorrection(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor,'approve')
  const id=input.text('correction',{max:100}),decision=input.text('decision',{max:10})
  insist(['approved','rejected'].includes(decision),'invalid_decision')
  const pending=guard(env,'correction_already_decided',"EXISTS(SELECT 1 FROM nc_usage_corrections WHERE id=? AND status='pending')",id)
  if(decision==='rejected'){
    insist(await one(env,'SELECT 1 FROM nc_usage_corrections WHERE id=?',id),'correction_not_found',404)
    await commit(env,[pending,stmt(env,"UPDATE nc_usage_corrections SET status='rejected',decided_by=?,decided_at=? WHERE id=?",actorLabel(actor),now(),id)],{actor:actorLabel(actor),action:'usage.correction.reject',subject:id})
    return {id,status:'rejected'}
  }
  const {row,p}=await checked(env,actor,id),s=p.summary
  await requireFreshFactor(env,actor)
  const preparer=row.authorized_by_id ?? (row.prepared_by_kind==='member'?row.prepared_by_id:null)
  insist(!s.needsSecondApprover || preparer && preparer!==actor.id,'second_approver_required',409)
  const statements=[sequenceGuard(env,p.seq),pending,
    ...(s.needsSecondApprover?[guard(env,'second_approver_required',"EXISTS(SELECT 1 FROM nc_members WHERE id=? AND status='active' AND role IN ('owner','finance'))",preparer)]:[]),
    stmt(env,"UPDATE nc_usage_corrections SET status='approved',decided_by=?,decided_at=? WHERE id=?",actorLabel(actor),now(),id)]
  for(const period of p.replay.periods) statements.push(stmt(env,'INSERT INTO nc_usage_replays(correction_id,invoice_id,customer_id,input_json,lines_json) VALUES(?,?,?,?,?)',id,period.invoice,s.customer,JSON.stringify(period.afterInput),JSON.stringify(period.after.lines)))
  // A bulk void is a set operation, not 10,000 D1 statements/subrequests.
  for(let n=0;n<p.normalized.void_event_ids.length;n+=1000)statements.push(stmt(env,'INSERT INTO nc_usage_voids(id,event_id,correction_id,customer_id) SELECT lower(hex(randomblob(16))),value,?,? FROM json_each(?)',id,s.customer,JSON.stringify(p.normalized.void_event_ids.slice(n,n+1000))))
  const additions=p.normalized.add_event_ids
  for(let n=0;n<additions.length;n+=80){const ids=additions.slice(n,n+80);statements.push(guard(env,'already_billed',`NOT EXISTS(SELECT 1 FROM nc_usage_events WHERE event_id IN (${ids.map(()=>'?').join(',')}) AND (invoice_id IS NOT NULL OR status<>'active'))`,...ids),
    stmt(env,`UPDATE nc_usage_events SET invoice_id=? WHERE event_id IN (${ids.map(()=>'?').join(',')})`,id,...ids))}
  let business=p.business
  const documents:Row[]=[],adjustments:UsageAdjustment[]=[]
  for(const period of s.periods){
    if(period.totalCents<0){
      const allocation=documentNumberAllocation(env,business,p.customer,'credit-note'),credit=newId(),at=clockInstant(env)
      statements.push(...allocation.statements,stmt(env,`INSERT INTO nc_credit_notes(id,number,invoice_id,customer_id,amount_cents,reason,issued_by,issued_at,applied_cents,subtotal_cents,tax_cents,correction_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        credit,allocation.number,period.invoice,s.customer,-period.totalCents,s.reason,actorLabel(actor),at,period.appliedCents,-period.subtotalCents,-period.taxCents,id),
        stmt(env,`INSERT INTO nc_revenue_credits(id,credit_id,invoice_id,customer_id,recognition_date,amount_cents,policy_version,basis_json) VALUES(?,?,?,?,?,?,?,?)`,
          credit,credit,period.invoice,s.customer,`${s.issueDate.slice(0,7)}-01`,period.subtotalCents,'nectar-revenue-1',JSON.stringify({method:'historical-usage-credit',correction:id,originalInvoice:period.invoice,originalTaxUnchanged:true,taxDeltaCents:period.taxCents,replayFingerprint:period.fingerprint,servicePeriodDeltas:period.revenue})))
      // The next reservation in this same batch compares against the counter
      // advanced by the preceding reservation, including customer series.
      if(p.customer.credit_prefix!==null && p.customer.credit_prefix!==undefined)p.customer.next_credit_number++
      else business={...business,next_credit_number:business.next_credit_number+1}
      documents.push({kind:'credit_note',id:credit,number:allocation.number,invoice:period.invoice,amountCents:-period.totalCents,appliedCents:period.appliedCents,carriedCents:period.carriedCents,issuedAt:at})
    }else if(period.subtotalCents!==0||period.taxCents!==0){
      const adjustment={id:newId(),correction:id,line:adjustmentLine(period,id),taxCents:period.taxCents}
      adjustments.push(adjustment)
      statements.push(stmt(env,'INSERT INTO nc_usage_adjustments(id,correction_id,customer_id,subscription_id,original_invoice_id,line_json,tax_cents) VALUES(?,?,?,?,?,?,?)',adjustment.id,id,s.customer,s.subscription,period.invoice,JSON.stringify(adjustment.line),adjustment.taxCents))
    }
  }
  let invoice:string|null=null
  if(adjustments.length && s.disposition!=='next_invoice'){
    const run=newId();invoice=newId()
    const source=p.replay.periods.at(-1)!.afterInput
    const inputs:RatingInput={...source,period:{start:s.issueDate,end:addDays(s.issueDate,1)},items:[],prices:{},amendments:[],events:[],contracts:undefined,charges:undefined,lifecycle:undefined,renewals:undefined,
      usageAdjustments:adjustments,usageCorrection:id,usageCredits:[...s.availableCredits,...documents.filter(d=>d.kind==='credit_note'&&d.carriedCents>0).map(d=>({id:d.id,number:d.number,availableCents:d.carriedCents,issuedAt:d.issuedAt,correction:id,source:`/app/invoices/${d.invoice}#credit-${d.id}`}))].sort((a,b)=>a.issuedAt-b.issuedAt||a.id.localeCompare(b.id)),invoiceContent:await invoiceContent(env,p.business,s.customer)}
    const r=rate(inputs),basis=await fingerprint(inputs)
    insist(r.totalCents>=0&&!r.exceptions.some(e=>e.code==='negative_total'),'negative_correcting_invoice',409)
    statements.push(stmt(env,`INSERT INTO nc_bill_runs(id,period,cutoff_at,calc_version,status,summary_json,created_by,created_at,kind) VALUES(?,?,?,?,'draft',?,?,?,'manual')`,run,s.issueDate.slice(0,7),now(),inputs.version,JSON.stringify({invoices:1,totals:{subtotal:r.subtotalCents,tax:r.taxCents,total:r.totalCents},correction:id}),actorLabel(actor),now()),
      stmt(env,`INSERT INTO nc_invoices(id,bill_run_id,customer_id,subscription_id,invoice_kind,period_start,period_end,status,subtotal_cents,tax_cents,total_cents,calc_version,source_fingerprint,calculation_json,comparison_json,exceptions_json,created_at) VALUES(?,?,?,?,'manual',?,?,'draft',?,?,?,?,? ,?,'{}',?,?)`,invoice,run,s.customer,s.subscription,s.issueDate,addDays(s.issueDate,1),r.subtotalCents,r.taxCents,r.totalCents,inputs.version,basis,JSON.stringify({version:inputs.version,fingerprint:basis,tax:r.tax,consumedEvents:[],inputs}),JSON.stringify(r.exceptions),now()),
      ...r.lines.map((line,index)=>stmt(env,`INSERT INTO nc_invoice_lines(id,invoice_id,seq,kind,description,quantity,unit_amount,amount_cents,taxable,price_id,meter_id,period_start,period_end,evidence_json) VALUES(?,?,?,?,?,?,?,?,0,NULL,NULL,?,?,?)`,newId(),invoice,index+1,line.kind,line.description,line.quantity,line.unitAmount,line.amountCents,line.periodStart,line.periodEnd,JSON.stringify(line.evidence))))
    // The dedicated invoice owns these staged adjustments; ordinary recurring
    // drafts must not also pick them up before it is issued.
    for(const a of adjustments)statements.push(stmt(env,'UPDATE nc_usage_adjustments SET target_invoice_id=? WHERE id=?',invoice,a.id))
    documents.push({kind:'correcting_invoice',id:invoice,status:'draft',totalCents:r.totalCents})
  }
  const body=s.message.body
  statements.push(stmt(env,'INSERT INTO nc_usage_correction_mail(correction_id,customer_id,recipient,subject,body,updated_at) VALUES(?,?,?,?,?,?)',id,s.customer,s.recipient,s.message.subject,body,now()))
  await commit(env,statements,{actor:actorLabel(actor),action:'usage.correction.approve',subject:id,detail:{basis:row.basis,disposition:s.disposition,delta:s.delta,documents,carriedCents:s.carriedCents}})
  await deliverUsageCorrectionMail(env,id)
  return {id,status:'approved',documents,invoice,carriedCents:s.carriedCents}
}

export async function usageCorrections(env: Bindings, actor: Actor, subscription: string): Promise<Row[]> {
  requireCapability(actor,'read')
  return await Promise.all((await all(env,'SELECT * FROM nc_usage_corrections WHERE subscription_id=? AND NOT EXISTS(SELECT 1 FROM nc_customers c WHERE c.id=customer_id AND c.erased_at IS NOT NULL) ORDER BY prepared_at DESC,id',subscription)).map(async row=>({...row,mail:await one(env,'SELECT recipient,subject,body,status,provider_ref FROM nc_usage_correction_mail WHERE correction_id=?',row.id),plan:parseJson<Row>(row.plan_json,{}),payload:parseJson<Row>(row.payload_json,{}),plan_json:undefined,payload_json:undefined})))
}
