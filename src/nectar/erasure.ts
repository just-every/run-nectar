import { historicalRevenueRetention } from './movein/history-revenue'
import { privacyCheckpoint } from './erasure-checkpoint'
import type { Bindings } from '../auth.server'
import { actorLabel, requireOwner, type Actor } from './actor'
import { all, insist, one, parseJson, type Row } from './core'
import { clockInstant } from './clock'
import { business } from './business'
import { addMonths,localDate } from './dates'
import type { Input } from './input'
import type { D1Sql } from '../modules/import-kit/src/d1/index'
import { erasurePlan } from './erasure-records'
import { eraseImportCopies } from './erasure-import'
import { erasureInsertStatements } from './erasure-sql'
import { importedCashCollections } from './processor-cash-imported'

const sql = (sql: string, ...params: unknown[]): D1Sql => ({ sql, params })
export async function approveErasure(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  insist(input.flag('confirm'),'erasure_confirmation_required')
  const id=input.text('request'),request=await one(env,'SELECT * FROM nc_erasure_requests WHERE id=?',id)
  insist(request?.status==='verified','verified_request_required',409)
  const customer=await one(env,'SELECT * FROM nc_customers WHERE id=?',request.customer_id)
  insist(customer && !customer.erased_at && customer.revision===request.customer_revision,'stale',409)
  const b=(await business(env))!
  const historyRevenue=await historicalRevenueRetention(env,customer.id)
  const plan=await erasurePlan(env,customer),at=clockInstant(env)
  const invoices=await all(env,"SELECT * FROM nc_invoices WHERE customer_id=? AND status='issued'",customer.id)
  const payments=await all(env,'SELECT * FROM nc_payments WHERE customer_id=?',customer.id)
  const credits=await all(env,'SELECT * FROM nc_credit_notes WHERE customer_id=?',customer.id)
  const incumbent=await all(env,'SELECT * FROM nc_incumbent_invoices WHERE customer_id=?',customer.id)
  const collected=[...await all(env,"SELECT * FROM nc_imported_collections WHERE customer_id=? AND charge_ref IS NOT NULL AND charge_ref<>'' AND collected_on IS NOT NULL",customer.id),...await importedCashCollections(env,customer.id)]
  const importedMoney=await all(env,"SELECT * FROM nc_incumbent_history WHERE customer_id=? AND amount_cents IS NOT NULL",customer.id)
  const processorMoney=[...await all(env,'SELECT id,amount_cents,occurred_at FROM nc_processor_cash_transactions WHERE customer_id=? AND amount_cents<>0',customer.id),...await all(env,'SELECT id,amount_cents,occurred_at FROM nc_processor_transactions WHERE customer_id=? AND amount_cents<>0',customer.id)]
  const bankMoney=await all(env,'SELECT id,amount_cents,received_on FROM nc_plaid_deposits WHERE customer_id=?',customer.id)
  const cashReturns=await all(env,'SELECT id,amount_cents,provider_created_at,completed_at FROM nc_processor_cash_returns WHERE customer_id=? AND provider_created_at IS NOT NULL',customer.id)
  const dates=[...bankMoney.map(record=>record.received_on),...processorMoney.map(record=>localDate(record.occurred_at,b.timezone)),...cashReturns.flatMap(record=>[record.provider_created_at,record.completed_at].filter(Boolean).map(at=>localDate(at,b.timezone))),...collected.map(record=>record.collected_on),...importedMoney.map(record=>record.occurred_on),...incumbent.map(record=>record.issue_date).filter(Boolean),...invoices.map(i=>i.issue_date),...payments.map(p=>p.received_on),...credits.map(c=>localDate(c.issued_at,b.timezone))].filter(Boolean).sort()
  const legacyAnchor=incumbent.some(record=>!record.issue_date)?localDate(at,b.timezone):null
  if(legacyAnchor)dates.push(legacyAnchor)
  dates.sort()
  const until=dates.length?addMonths(dates.at(-1)!,84):null
  const redact=(text:string)=>plan.personalValues.reduce((s,v)=>s.split(v).join('[erased]'),text)
  plan.changes.push({kind:'nc_erasure_requests',fields:['recipient','claimed_email','token_hash','evidence_base64','evidence_name','verification_reason'],records:(await all(env,'SELECT id FROM nc_erasure_requests WHERE customer_id=?',customer.id)).length})
  const receipt={clause:'GOV-005',request:id,customer:customer.id,approvedAt:at,approvedBy:actor.id,verification:{method:request.verified_method,at:request.verified_at,reason:redact(request.verification_reason??''),evidence:request.evidence_sha256?{sha256:request.evidence_sha256,bytes:request.evidence_size,status:'verification file withdrawn after erasure'}:null},changed:plan.changes,retained:{timezone:b.timezone,legalLabels:{issueSnapshots:invoices.filter(i=>!!i.legal_name).length,legacyDisplayedLabels:invoices.filter(i=>!i.legal_name).length,basis:'Retained invoice legal label: issue snapshot where saved; otherwise the label displayed at erasure, not a reconstructed historical identity.'},fields:['legal_name','amount_cents','tax_cents','tax_json','document_date','record_id'],invoiceRecords:invoices.length,paymentRecords:payments.length,creditRecords:credits.length,incumbentRecords:incumbent.length,legacyAnchor,legacyDateRule:legacyAnchor?'Legacy issue/payment dates unavailable; conservative anchor = erasure approval':null,until,basis:'Seven calendar years from the latest issued-document or payment date; anniversary clamps to the last valid day of the month.'},archive:'Personal data removed from the current installation and future archives. Older archives are refused when the destination or a trusted later journal knows this erasure checkpoint; previously downloaded copies cannot be recalled.'}
  const statements:D1Sql[]=[
    sql("INSERT INTO nc_guard(code,ok) SELECT 'stale',CASE WHEN (SELECT value FROM nc_privacy_generation WHERE id=1)=? THEN 1 ELSE 0 END",plan.generation),
    sql(`INSERT INTO nc_guard(code,ok) SELECT 'stale',CASE WHEN EXISTS(SELECT 1 FROM nc_erasure_requests WHERE id=? AND status='verified' AND customer_revision=?) THEN 1 ELSE 0 END`,id,customer.revision),
    sql('UPDATE nc_erasure_requests SET approved_by=?,approved_at=? WHERE id=?',actorLabel(actor),at,id),
    sql('INSERT INTO nc_privacy_context(request_id) VALUES(?)',id),
    ...historyRevenue,
    ...plan.statements,
    ...erasureInsertStatements('nc_erased_records',['record_id','request_id'],plan.ids.map(record=>[record,id]),true),
  ]
  const retained: unknown[][]=[]
  for(const [kind,records] of [['invoice',invoices],['payment',payments],['credit-note',credits],['incumbent-invoice',incumbent]] as const) for(const record of records) retained.push([id,kind,record.id,record.legal_name||customer.name,['invoice','incumbent-invoice'].includes(kind)?record.total_cents:record.amount_cents,['invoice','incumbent-invoice'].includes(kind)?record.tax_cents:0,kind==='invoice'?record.issue_date:kind==='payment'?record.received_on:kind==='incumbent-invoice'?(record.issue_date??legacyAnchor):localDate(record.issued_at,b.timezone),until,kind==='invoice'?JSON.stringify(Object.fromEntries(Object.entries(parseJson<Row>(record.calculation_json,{}).tax??{}).filter(([key])=>['mode','jurisdiction','taxableBaseCents','rate','exempt','rule'].includes(key)))):'{}'])
  for(const record of collected)retained.push([id,'incumbent-collection',record.id,customer.name,record.amount_cents,0,record.collected_on,until,'{}'])
  for(const record of importedMoney)retained.push([id,`incumbent-${record.kind}`,record.id,customer.name,record.amount_cents,0,record.occurred_on,until,'{}'])
  for(const record of processorMoney)retained.push([id,'processor-cash',record.id,customer.name,record.amount_cents,0,localDate(record.occurred_at,b.timezone),until,'{}'])
  for(const record of bankMoney)retained.push([id,'bank-deposit',record.id,customer.name,record.amount_cents,0,record.received_on,until,'{}'])
  for(const record of cashReturns)retained.push([id,'processor-cash-return',record.id,customer.name,-record.amount_cents,0,localDate(record.completed_at??record.provider_created_at,b.timezone),until,'{}'])
  statements.push(...erasureInsertStatements('nc_erasure_financial',['request_id','kind','record_id','legal_name','amount_cents','tax_cents','document_date','retain_until','tax_json'],retained))
  // Every request for this customer loses its recipient/token, not just the one
  // approved. No pending mail or public link can revive an erased identity.
  statements.push(sql(`UPDATE nc_erasure_requests SET recipient='',claimed_email='',token_hash=NULL,evidence_base64=NULL,evidence_name=CASE WHEN evidence_sha256 IS NULL THEN NULL ELSE 'verification-evidence' END,verification_reason=CASE WHEN id=? THEN ? ELSE '' END WHERE customer_id=?`,id,redact(request.verification_reason??''),customer.id),sql(`UPDATE nc_erasure_requests SET status='complete',receipt_json=?,retain_until=? WHERE id=?`,JSON.stringify(receipt),until,id),sql('DELETE FROM nc_guard'),sql('INSERT INTO nc_audit(at,actor,action,subject,detail) VALUES(?,?,?,?,?)',at,actorLabel(actor),'erasure.complete',id,JSON.stringify({customer:customer.id,request:id,verification:receipt.verification,changed:plan.changes,retainUntil:until})))
  const result=await eraseImportCopies(env,actor,customer,statements,await privacyCheckpoint(env))
  return {id,receipt:parseJson((await one(env,'SELECT receipt_json FROM nc_erasure_requests WHERE id=?',id))!.receipt_json,receipt),importCustody:{receipt:result.receiptId}}
}
