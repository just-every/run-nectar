import type { Bindings } from '../auth.server'
import { actorLabel,requireOwner,type Actor } from './actor'
import { all,commit,fingerprint,guard,insist,newId,now,one,parseJson,stmt,type Row } from './core'
import { requireFreshFactor } from './mfa'
import type { Input } from './input'
import { requireBusiness } from './business'
import { invoiceContent } from './invoice-content'
import { billingComponentClaimStatements } from './billing-components'
import { cents } from './decimal'
import { requireDate } from './dates'

export async function setHierarchy(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor);await requireFreshFactor(env,actor)
  input.only(['customer','parent','billing_mode','revision','consent','returnTo'])
  insist(input.flag('consent'),'hierarchy_consent_required')
  const child=input.text('customer'),parent=input.text('parent'),mode=input.text('billing_mode'),revision=input.integer('revision',{min:0})!
  insist(child!==parent&&['consolidated','separate'].includes(mode),'invalid_hierarchy')
  const rows=await all(env,"SELECT id,billing_entity_id,revision FROM nc_customers WHERE id IN (?,?) AND erased_at IS NULL AND status='active'",child,parent)
  insist(rows.length===2,'customer_not_found',404)
  insist(rows[0].billing_entity_id===rows[1].billing_entity_id,'hierarchy_entity_mismatch',409)
  const existing=await one(env,'SELECT * FROM nc_customer_hierarchies WHERE customer_id=?',child)
  insist(!existing||existing.parent_id===parent,'hierarchy_parent_fixed',409)
  await commit(env,[
    guard(env,'stale','COALESCE((SELECT revision FROM nc_customer_hierarchies WHERE customer_id=?),0)=?',child,revision),
    guard(env,'hierarchy_cycle','NOT EXISTS(SELECT 1 FROM nc_customer_hierarchies WHERE customer_id=? OR parent_id=?)',parent,child),
    ...rows.map(r=>guard(env,'stale',"EXISTS(SELECT 1 FROM nc_customers WHERE id=? AND revision=? AND erased_at IS NULL AND status='active')",r.id,r.revision)),
    stmt(env,'INSERT INTO nc_customer_hierarchies(customer_id,parent_id,billing_mode,revision,authorized_by,authorized_at) VALUES(?,?,?,1,?,?) ON CONFLICT(customer_id) DO UPDATE SET billing_mode=excluded.billing_mode,revision=revision+1,authorized_by=excluded.authorized_by,authorized_at=excluded.authorized_at',child,parent,mode,actorLabel(actor),now()),
  ],{actor:actorLabel(actor),action:'hierarchy.configure',subject:child,detail:{parent,billing_mode:mode,consent:true}})
  return {id:parent,child,revision:revision+1}
}
export async function hierarchyView(env: Bindings, actor: Actor, parent?: string) {
  requireOwner(actor)
  const links=await all(env,`SELECT h.*,c.name AS child_name,p.name AS parent_name FROM nc_customer_hierarchies h JOIN nc_customers c ON c.id=h.customer_id JOIN nc_customers p ON p.id=h.parent_id WHERE c.erased_at IS NULL AND p.erased_at IS NULL ${parent?'AND h.parent_id=?':''} ORDER BY p.name,c.name`,...(parent?[parent]:[]))
  const commitments:Row[]=[]
  for(const w of await all(env,`SELECT * FROM nc_hierarchy_commitments ${parent?'WHERE parent_id=?':''} ORDER BY from_date,id`,...(parent?[parent]:[]))){
    const sources=await all(env,`SELECT i.id,i.number,i.subtotal_cents,i.issue_date,i.customer_id FROM nc_invoices i JOIN nc_customer_hierarchies h ON h.customer_id=i.customer_id WHERE h.parent_id=? AND i.status='issued' AND i.period_start>=? AND i.period_end<=? ORDER BY i.issue_date,i.id`,w.parent_id,w.from_date,w.to_date)
    const consolidated=await all(env,"SELECT i.id,i.number,i.calculation_json FROM nc_invoices i WHERE i.customer_id=? AND i.status='issued' AND i.period_start>=? AND i.period_end<=? AND EXISTS(SELECT 1 FROM nc_hierarchy_sources s WHERE s.invoice_id=i.id)",w.parent_id,w.from_date,w.to_date)
    const drawdowns=[...sources.map(i=>({invoice:i.id,number:i.number,customer:i.customer_id,amountCents:i.subtotal_cents})),...consolidated.flatMap(i=>(parseJson<Row>(i.calculation_json,{}).inputs?.consolidation?.sections??[]).map((s:Row)=>({invoice:i.id,number:i.number,customer:s.customer,amountCents:s.subtotalCents})))]
    const used=drawdowns.reduce((sum,r)=>sum+r.amountCents,0)
    commitments.push({...w,drawdowns,drawnCents:used,remainingCents:Math.max(0,w.amount_cents-used),overageCents:Math.max(0,used-w.amount_cents),custody:'shared-spend-tracking; not prepaid funding or a minimum true-up'})
  }
  return {links,commitments}
}
export async function recordHierarchyCommitment(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor);await requireFreshFactor(env,actor)
  input.only(['parent','amount','from','to','consent','returnTo']);insist(input.flag('consent'),'hierarchy_consent_required')
  const parent=input.text('parent'),amount=cents(input.text('amount')),from=requireDate(input.text('from'),'from'),to=requireDate(input.text('to'),'to')
  insist(amount>0&&to>from,'invalid_commitment')
  insist(await one(env,'SELECT 1 FROM nc_customer_hierarchies WHERE parent_id=?',parent),'hierarchy_not_found',404)
  const id=newId()
  await commit(env,[guard(env,'overlapping_commitment','NOT EXISTS(SELECT 1 FROM nc_hierarchy_commitments WHERE parent_id=? AND from_date<? AND to_date>?)',parent,to,from),stmt(env,'INSERT INTO nc_hierarchy_commitments(id,parent_id,customer_id,amount_cents,from_date,to_date,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)',id,parent,parent,amount,from,to,actorLabel(actor),now())],{actor:actorLabel(actor),action:'hierarchy.commitment',subject:id,detail:{parent,amount,from,to,reportingOnly:true}})
  return {id:parent,commitment:id}
}

export async function consolidationCalculation(env: Bindings, parent: string, ids: string[]) {
  const b=await requireBusiness(env),parentRow=await one(env,"SELECT * FROM nc_customers WHERE id=? AND erased_at IS NULL AND status='active'",parent)
  insist(parentRow,'customer_not_found',404)
  const sources=await all(env,`SELECT i.*,h.parent_id,h.billing_mode AS hierarchy_mode,h.revision AS hierarchy_revision,c.name AS child_name,c.billing_entity_id AS child_entity FROM nc_invoices i JOIN nc_customer_hierarchies h ON h.customer_id=i.customer_id JOIN nc_customers c ON c.id=i.customer_id WHERE i.id IN (${ids.map(()=>'?').join(',')}) ORDER BY i.customer_id,i.id`,...ids)
  insist(sources.length===ids.length&&sources.every(s=>s.parent_id===parent&&s.hierarchy_mode==='consolidated'&&s.status==='draft'&&s.invoice_kind==='recurring'&&s.child_entity===parentRow.billing_entity_id),'consolidation_sources_changed',409)
  insist(sources.every(s=>s.period_start===sources[0].period_start&&s.period_end===sources[0].period_end),'consolidation_period_mismatch',409)
  const {currentFingerprint}=await import('./billruns')
  const sections:Row[]=[];const lines:Row[]=[]
  for(const source of sources){
    const original=parseJson<Row>(source.calculation_json,{})
    insist(!original.inputs?.prepaid&&!original.inputs?.contracts&&!original.inputs?.usageCredits?.length&&!original.inputs?.usageAdjustments?.length,'consolidation_special_terms_pending',409)
    insist(await currentFingerprint(env,b,source)===source.source_fingerprint,'source_changed',409)
    const sourceLines=await all(env,'SELECT * FROM nc_invoice_lines WHERE invoice_id=? ORDER BY seq',source.id)
    sections.push({customer:source.customer_id,name:source.child_name,subscription:source.subscription_id,sourceInvoice:source.id,fingerprint:source.source_fingerprint,hierarchyRevision:source.hierarchy_revision,subtotalCents:source.subtotal_cents,taxCents:source.tax_cents,totalCents:source.total_cents,calculation:original})
    lines.push(...sourceLines.map(l=>({...l,sourceInvoice:source.id,child:source.customer_id,childName:source.child_name})))
  }
  const content=await invoiceContent(env,b,parent)
  const input={version:'nectar-consolidation-1',invoiceContent:content,consolidation:{parent,sections}}
  return {input,sections,lines,sources,fingerprint:await fingerprint(input),period:{start:sources[0].period_start,end:sources[0].period_end},subtotal:sections.reduce((n,s)=>n+s.subtotalCents,0),tax:sections.reduce((n,s)=>n+s.taxCents,0),total:sections.reduce((n,s)=>n+s.totalCents,0),exceptions:sources.flatMap(s=>parseJson<Row[]>(s.exceptions_json,[]).map(e=>({...e,message:`${s.child_name}: ${e.message}`})))}
}
export async function prepareConsolidation(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  input.only(['parent','invoices','returnTo'])
  const parent=input.text('parent'),ids=input.list('invoices');insist(ids.length>0&&ids.length<=20&&new Set(ids).size===ids.length,'invoices_required')
  const c=await consolidationCalculation(env,parent,ids),run=newId(),invoice=newId(),at=now()
  const calculation={version:c.input.version,fingerprint:c.fingerprint,inputs:c.input,tax:{rule:'Exact sum of each division’s frozen tax calculation'},consumedEvents:[...new Set(c.sections.flatMap(s=>s.calculation.consumedEvents??[]))]}
  await commit(env,[
    ...c.sources.map(s=>guard(env,'source_changed',"EXISTS(SELECT 1 FROM nc_invoices WHERE id=? AND status='draft' AND source_fingerprint=?)",s.id,s.source_fingerprint)),
    stmt(env,"INSERT INTO nc_bill_runs(id,period,cutoff_at,calc_version,status,summary_json,created_by,created_at,kind) VALUES(?,?,?,?,'draft',?,?,?,'manual')",run,c.period.start.slice(0,7),at,c.input.version,JSON.stringify({invoices:1,shadow:0,totals:{subtotal:c.subtotal,tax:c.tax,total:c.total},exceptions:{},consolidated:true}),actorLabel(actor),at),
    stmt(env,"INSERT INTO nc_invoices(id,bill_run_id,customer_id,subscription_id,invoice_kind,period_start,period_end,status,subtotal_cents,tax_cents,total_cents,calc_version,source_fingerprint,calculation_json,comparison_json,exceptions_json,created_at) VALUES(?,?,?,NULL,'manual',?,?,'draft',?,?,?,?,? ,?,'{}',?,?)",invoice,run,parent,c.period.start,c.period.end,c.subtotal,c.tax,c.total,c.input.version,c.fingerprint,JSON.stringify(calculation),JSON.stringify(c.exceptions),at),
    ...c.sources.map(s=>stmt(env,'INSERT INTO nc_hierarchy_sources(invoice_id,source_invoice_id,customer_id,subscription_id,source_fingerprint) VALUES(?,?,?,?,?)',invoice,s.id,s.customer_id,s.subscription_id,s.source_fingerprint)),
    ...c.lines.map((l,index)=>stmt(env,'INSERT INTO nc_invoice_lines(id,invoice_id,seq,kind,description,quantity,unit_amount,amount_cents,taxable,price_id,meter_id,period_start,period_end,evidence_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',newId(),invoice,index+1,l.kind,l.description,l.quantity,l.unit_amount,l.amount_cents,l.taxable,l.price_id,l.meter_id,l.period_start,l.period_end,JSON.stringify({...parseJson<Row>(l.evidence_json,{}),hierarchy:{child:l.child,name:l.childName,sourceInvoice:l.sourceInvoice}}))),
  ],{actor:actorLabel(actor),action:'hierarchy.invoice.prepare',subject:invoice,detail:{parent,sources:ids,fingerprint:c.fingerprint}})
  return {id:invoice,run}
}
export async function hierarchyPreIssue(env: Bindings, invoice: Row) {
  const saved=parseJson<Row>(invoice.calculation_json,{}).inputs?.consolidation
  if(!saved)return []
  const generation=(await one(env,'SELECT value FROM nc_privacy_generation WHERE id=1'))!.value
  const c=await consolidationCalculation(env,saved.parent,saved.sections.map((s:Row)=>s.sourceInvoice))
  insist(c.fingerprint===invoice.approved_fingerprint,'source_changed',409)
  return [guard(env,'source_changed','(SELECT value FROM nc_privacy_generation WHERE id=1)=?',generation)]
}
export async function hierarchyIssueStatements(env: Bindings, invoice: Row) {
  const saved=parseJson<Row>(invoice.calculation_json,{}).inputs
  const link=await one(env,"SELECT * FROM nc_customer_hierarchies WHERE customer_id=? AND billing_mode='separate'",invoice.customer_id)
  if(!saved?.consolidation)return link?[stmt(env,'INSERT INTO nc_invoice_payers(invoice_id,customer_id,payer_id,hierarchy_revision,authorized_by,authorized_at) VALUES(?,?,?,?,?,?)',invoice.id,invoice.customer_id,link.parent_id,link.revision,link.authorized_by,link.authorized_at)]:[]
  return saved.consolidation.sections.flatMap((s:Row)=>[
    guard(env,'consolidation_already_issued',"EXISTS(SELECT 1 FROM nc_invoices WHERE id=? AND status='draft') AND NOT EXISTS(SELECT 1 FROM nc_hierarchy_consumed WHERE source_invoice_id=?)",s.sourceInvoice,s.sourceInvoice),
    stmt(env,"UPDATE nc_invoices SET status='discarded' WHERE id=?",s.sourceInvoice),
    stmt(env,'INSERT INTO nc_hierarchy_consumed(source_invoice_id,invoice_id,customer_id,subscription_id,period_start,billing_key) SELECT id,?,customer_id,subscription_id,period_start,billing_key FROM nc_invoices WHERE id=?',invoice.id,s.sourceInvoice),
    ...(s.calculation.inputs?.billing?billingComponentClaimStatements(env,s.subscription,invoice.id,s.calculation.inputs.billing):[]),
    ...(s.calculation.inputs?.charges??[]).map((charge:Row)=>stmt(env,'UPDATE nc_charges SET invoice_id=? WHERE id=? AND invoice_id IS NULL',invoice.id,charge.id)),
  ])
}
