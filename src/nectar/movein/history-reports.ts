// Historical financial projections use retained provider facts, never the live
// catalogue or invoice engine. Native and imported identities stay separate.
import type { Bindings } from '../../auth.server'
import { all, insist, parseJson, type Row } from '../core'
import { daysBetween, isDate } from '../dates'
import type { Report, ReportEntry, ReportInvoice, ReportMetric } from '../reports'
import { importedCashCollections } from '../processor-cash-imported'

export const historicalHref = (customer: string, id: string) => `/app/customers/${customer}#history-${id}`
export async function customerHistory(env: Bindings, customer: string) {
  const documents = await all(env, 'SELECT * FROM nc_incumbent_invoices WHERE customer_id=? ORDER BY COALESCE(issue_date,period_start),id', customer)
  const records = await all(env, 'SELECT * FROM nc_incumbent_history WHERE customer_id=? ORDER BY occurred_on,id', customer)
  const cash=await importedCashCollections(env,customer)
  const collected=[...await all(env,"SELECT p.* FROM nc_imported_collections p WHERE p.customer_id=? AND p.charge_ref IS NOT NULL AND p.collected_on IS NOT NULL",customer),...cash]
  const additional=collected.filter(payment=>!records.some(record=>record.kind==='payment'&&record.status==='succeeded'&&(record.id===payment.history_payment_id||record.provider_ref===payment.charge_ref)))
  const cashRecords=cash.filter(row=>additional.includes(row)).map(row=>historicalFinancialFacts({...row,provider:'stripe',provider_ref:row.charge_ref,kind:'payment',status:'succeeded',occurred_on:row.collected_on}))
  return { totals:{invoicedCents:documents.filter(row=>row.document_kind==='invoice'&&['paid','open','uncollectible'].includes(row.status)).reduce((n,row)=>n+row.total_cents,0), creditedCents:documents.filter(row=>row.document_kind==='credit-note'&&row.status==='issued').reduce((n,row)=>n+row.total_cents,0),paymentsCents:records.filter(row=>row.kind==='payment'&&row.status==='succeeded').reduce((n,row)=>n+row.amount_cents,0)+additional.reduce((n,row)=>n+row.amount_cents,0),refundsCents:records.filter(row=>row.kind==='refund'&&row.status==='succeeded').reduce((n,row)=>n+row.amount_cents,0),remainingCents:documents.filter(row=>row.document_kind==='invoice'&&row.status==='open').reduce((n,row)=>n+Math.max(0,row.remaining_cents-collected.filter(payment=>payment.invoice_id===row.id).reduce((sum,payment)=>sum+payment.amount_cents,0)),0)}, documents: documents.map(row => ({ ...historicalFinancialFacts(row), lines: publicLines(row.lines_json) })), records: [...records.map(row => ({ ...historicalFinancialFacts(row), ...(row.kind==='subscription-event'?{timeline:subscriptionSnapshot(parseJson<Row>(row.payload_json,{}))}:{}) })),...cashRecords] }
}
// CT 21 October: originals are opaque downloads, never inline evidence for
// any role. Every projection below selects typed facts, never provider prose.
const object = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value)
export const historyReference = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value)
const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value)
const date = (value: unknown) => typeof value === 'string' && isDate(value)
const currency = (value: unknown) => typeof value === 'string' && /^[a-z]{3}$/.test(value)
const choice = (...values: string[]) => (value: unknown) => typeof value === 'string' && values.includes(value)
const fields = (source: Row, allowed: Record<string, (value: unknown) => boolean>): Row => Object.fromEntries(Object.entries(allowed).filter(([key, valid]) => source[key] === null || valid(source[key])).map(([key]) => [key, source[key]]))
const status = choice('open','paid','uncollectible','void','issued','succeeded','pending','failed','requires_action','canceled','warning_needs_response','warning_under_review','warning_closed','needs_response','under_review','won','lost','prevented','active','trialing','past_due','unpaid','incomplete','incomplete_expired','paused')
export function historicalFinancialFacts(row: Row) {
  return fields(row, { id: historyReference, provider: choice('stripe','retained'), provider_ref: historyReference,
    customer_id: historyReference, subscription_id: historyReference, number: historyReference,
    document_kind: choice('invoice','credit-note'), kind: choice('payment','refund','dispute','subscription-event'),
    status, currency, issue_date: date, due_date: date, period_start: date, period_end: date, occurred_on: date,
    total_cents: integer, tax_cents: integer, paid_cents: integer, remaining_cents: integer, amount_cents: integer,
    invoice_ref: historyReference, subscription_ref: historyReference })
}
export function publicHistoricalLine(line: Row) {
  return fields(line, { source_id: historyReference, id: historyReference, price_ref: historyReference, subscription_ref: historyReference,
    kind: choice('flat','seat','unit','usage','discount','imported_line'), period_start: date, period_end: date, currency,
    amount_cents: integer, amount_excluding_tax_cents: integer, discount_amount_cents: integer,
    quantity: value => integer(value) && Number(value) >= 0, proration: value => typeof value === 'boolean', recurring: value => typeof value === 'boolean',
    interval: choice('day','week','month','year'), interval_unit: choice('day','week','month','year'), interval_count: value => integer(value) && Number(value) > 0 })
}
function publicLines(text: string) {
  const lines = parseJson<unknown>(text, [])
  return Array.isArray(lines) ? lines.filter(object).map(publicHistoricalLine) : []
}
function subscriptionSnapshot(event: Row) {
  const source = object(event.data?.object) ? event.data.object : {}
  const timestamp = (value: unknown) => integer(value) && Number(value) >= 0 && Number(value) <= 253402300799
  const snapshot = fields(source, { id: historyReference, status,
    start_date: timestamp, trial_start: timestamp, trial_end: timestamp, canceled_at: timestamp, ended_at: timestamp, cancel_at: timestamp,
    cancel_at_period_end: value => typeof value === 'boolean' })
  if (object(source.pause_collection)) snapshot.pause_collection = fields(source.pause_collection, { behavior: choice('keep_as_draft','mark_uncollectible','void'), resumes_at: timestamp })
  if (Array.isArray(source.items?.data)) snapshot.items = { data: source.items.data.filter(object).map((item: Row) => fields({ id: item.id, quantity: item.quantity, price: typeof item.price === 'string' ? item.price : item.price?.id }, { id: historyReference, quantity: value => integer(value) && Number(value) >= 0, price: historyReference })) }
  return { ...fields(event, { id: historyReference, type: choice('customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','customer.subscription.paused','customer.subscription.resumed','customer.subscription.trial_will_end'), created: timestamp }), data: { object: snapshot } }
}
const sourceHref = (metric: string, id: string, month: string, customer: string | null, bucket: string | null) => {
  const query = new URLSearchParams({ period: month }); if (customer) query.set('customer', customer); if (bucket) query.set('bucket', bucket)
  return `/app/reports/${metric}/${id}?${query}`
}
const bucketOf = (due: string, day: string) => {const days=daysBetween(due,day);return days<=0?'current':days<=30?'1-30':days<=60?'31-60':days<=90?'61-90':'90+'}
interface HistoricalContribution { entry: ReportEntry; row: Row; components: ReportInvoice['components']; original: Row }

export async function historicalContributions(env: Bindings, metric: ReportMetric, month: string, customer: string | null, day: string, bucket: string | null = null): Promise<HistoricalContribution[]> {
  if (['unbilled','credit-balances'].includes(metric)) return []
  const documents = await all(env, `SELECT i.*,c.name AS customer_name,c.erased_at FROM nc_incumbent_invoices i JOIN nc_customers c ON c.id=i.customer_id WHERE 1=1 ${customer?'AND i.customer_id=?':''} ORDER BY i.issue_date,i.id`, ...(customer?[customer]:[]))
  const result: HistoricalContribution[] = []
  const add=(row: Row, amount: number, components: ReportInvoice['components'], original: Row, kind: ReportEntry['sourceKind'])=> {
    insist(Number.isSafeInteger(amount),'invalid_historical_amount',409)
    result.push({row,components,original:historicalFinancialFacts(row),entry:{invoiceId:row.id,number:row.number||row.provider_ref,customerId:row.customer_id,customerName:row.customer_name,amountCents:amount,href:sourceHref(metric,row.id,month,customer,bucket),sourceKind:kind,sourceProvider:row.erased_at?'stripe':row.provider,sourceReference:row.erased_at?row.id:row.provider_ref}})
  }
  if(metric==='collections') {
    const payments=await all(env,`SELECT p.*,c.name AS customer_name,c.erased_at FROM nc_incumbent_history p JOIN nc_customers c ON c.id=p.customer_id WHERE p.kind='payment' AND p.status='succeeded' AND substr(p.occurred_on,1,7)=? AND p.occurred_on<=? ${customer?'AND p.customer_id=?':''} ORDER BY p.occurred_on,p.id`,month,day,...(customer?[customer]:[]))
    for(const row of payments)add(row,row.amount_cents,[{kind:'imported_payment',label:`${row.provider} payment ${row.provider_ref}`,amountCents:row.amount_cents,href:historicalHref(row.customer_id,row.id)}],parseJson<Row>(row.payload_json,{}),'payment')
    const collected=await all(env,`SELECT p.*,c.name AS customer_name,c.erased_at,'stripe' AS provider,p.charge_ref AS provider_ref FROM nc_imported_collections p JOIN nc_customers c ON c.id=p.customer_id WHERE p.charge_ref IS NOT NULL AND p.collected_on IS NOT NULL AND substr(p.collected_on,1,7)=? AND p.collected_on<=? ${customer?'AND p.customer_id=?':''} AND NOT EXISTS(SELECT 1 FROM nc_incumbent_history h WHERE h.kind='payment' AND h.status='succeeded' AND (h.id=p.history_payment_id OR (p.charge_ref<>'' AND h.provider_ref=p.charge_ref))) ORDER BY p.collected_on,p.id`,month,day,...(customer?[customer]:[]))
    const cash=await importedCashCollections(env,customer??undefined)
    for(const row of cash){
      if(row.collected_on.slice(0,7)!==month||row.collected_on>day||payments.some(p=>p.id===row.history_payment_id||(row.charge_ref&&p.provider_ref===row.charge_ref)))continue
      const document=documents.find(document=>document.id===row.invoice_id)
      if(document)collected.push({...row,customer_name:document.customer_name,erased_at:document.erased_at,provider:'stripe',provider_ref:row.charge_ref})
    }
    for(const row of collected)add(row,row.amount_cents,[{kind:'imported_collection',label:`Stripe payment on original invoice ${row.number}`,amountCents:row.amount_cents,href:historicalHref(row.customer_id,row.invoice_id)}],{invoice:row.invoice_ref,charge:row.charge_ref,payment:row.payment_ref,collectedOn:row.collected_on,amountCents:row.amount_cents,currency:row.currency},'payment')
    return result
  }
  const collectedAmounts=new Map((await all(env,"SELECT invoice_id,SUM(amount_cents) AS amount FROM nc_imported_collections WHERE charge_ref IS NOT NULL AND collected_on IS NOT NULL GROUP BY invoice_id")).map(row=>[row.invoice_id,row.amount]))
  for(const row of await importedCashCollections(env,customer??undefined))collectedAmounts.set(row.invoice_id,(collectedAmounts.get(row.invoice_id)??0)+row.amount_cents)
  const recurringRecords=metric==='mrr'?new Map((await (await import('./history-revenue')).historicalRevenueInvoices(env,null,customer)).map(record=>[record.invoice.id,record])):null
  for(const row of documents) {
    const original=parseJson<Row>(row.source_json,{}),href=historicalHref(row.customer_id,row.id)
    // Older captures lack a finalized date. They remain visible as custody but
    // do not invent a billing date or a financial contribution.
    if(!row.issue_date)continue
    const credit=row.document_kind==='credit-note'
    if(credit) {
      if(row.status!=='issued'||row.issue_date.slice(0,7)!==month)continue
      if(metric==='credits')add(row,row.total_cents,[{kind:'imported_credit',label:`${row.provider} credit note ${row.number}`,amountCents:row.total_cents,href}],original,'credit_note')
      if(metric==='tax'&&row.tax_cents)add(row,-row.tax_cents,[{kind:'imported_credit_tax',label:`${row.provider} original attributed credit tax ${row.number}`,amountCents:-row.tax_cents,href}],original,'credit_note')
      continue
    }
    if(!['paid','open','uncollectible'].includes(row.status))continue
    const lines=publicLines(row.lines_json)
    if(metric==='billings'&&row.issue_date.slice(0,7)===month) {
      const components=row.erased_at?[{kind:'retained_consideration',label:'Retained original pretax invoice amount',amountCents:row.total_cents-row.tax_cents,href}]:lines.map((line,index)=>({kind:line.kind||'imported_line',label:`${row.provider}: ${line.source_id||`line ${index+1}`}`,amountCents:line.amount_cents,href}))
      components.push({kind:'tax',label:`${row.provider} original invoice tax`,amountCents:row.tax_cents,href})
      insist(components.reduce((sum,line)=>sum+line.amountCents,0)===row.total_cents,'historical_invoice_does_not_reconcile',409,{invoice:row.provider_ref})
      add(row,row.total_cents,components,original,'invoice')
    }
    if(metric==='tax'&&row.issue_date.slice(0,7)===month)add(row,row.tax_cents,[{kind:'tax',label:`${row.provider} original invoice tax`,amountCents:row.tax_cents,href}],original,'invoice')
    if(metric==='ar'&&row.status==='open'&&row.remaining_cents-(collectedAmounts.get(row.id)??0)>0&&row.due_date&&(!bucket||(bucket==='overdue'?row.due_date<day:bucketOf(row.due_date,day)===bucket))) {
      add(row,row.remaining_cents-(collectedAmounts.get(row.id)??0),[{kind:'original',label:`${row.provider} original invoice`,amountCents:row.total_cents,href},{kind:'source_settlement',label:`${row.provider} recorded settlements and credits`,amountCents:row.remaining_cents-row.total_cents,href},{kind:'imported_collection',label:'Payment of the original Stripe invoice',amountCents:-(collectedAmounts.get(row.id)??0),href}],original,'invoice')
    }
    if(metric==='mrr') {
      const components=(recurringRecords?.get(row.id)?.schedules??[]).flatMap((schedule)=>{
        if(schedule.kind!=='imported_recurring'&&schedule.kind!=='imported_discount')return []
        const amount=schedule.entries.filter(entry=>entry.period===month).reduce((sum,entry)=>sum+entry.amountCents,0)
        return amount?[{kind:'imported_recurring',label:row.erased_at?'Retained recurring consideration':`${row.provider}: ${schedule.lineId}`,amountCents:amount,href}]:[]
      })
      if(components.length)add(row,components.reduce((sum,line)=>sum+line.amountCents,0),components,original,'invoice')
    }
  }
  return result
}
export async function historicalReportSource(env: Bindings, report: Report, id: string, url: URL, day: string): Promise<ReportInvoice | null> {
  const entry=report.entries.find(row=>row.invoiceId===id)
  if(!entry?.sourceProvider)return null
  const sources=await historicalContributions(env,report.metric,report.period.slice(0,7),url.searchParams.get('customer'),day,url.searchParams.get('bucket'))
  const source=sources.find(row=>row.entry.invoiceId===id);insist(source,'report_invoice_not_found',404)
  const {row}=source
  return {...entry,metric:report.metric,title:report.title,definition:report.definition,period:report.period,totalCents:entry.amountCents,components:source.components,
    historical:{provider:row.erased_at?'stripe':row.provider,reference:row.erased_at?row.id:row.provider_ref,href:historicalHref(row.customer_id,row.id),original:source.original},
    invoice:report.metric==='collections'?null:{id:row.id,number:row.number,customerId:row.customer_id,customerName:row.customer_name,subscriptionId:row.subscription_id,issueDate:row.issue_date,dueDate:row.due_date,periodStart:row.period_start,periodEnd:row.period_end,currency:row.currency,status:row.status,totalCents:row.total_cents,taxCents:row.tax_cents}}
}
