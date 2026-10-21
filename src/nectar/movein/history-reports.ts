// Historical financial projections use retained provider facts, never the live
// catalogue or invoice engine. Native and imported identities stay separate.
import type { Bindings } from '../../auth.server'
import { all, insist, parseJson, type Row } from '../core'
import { daysBetween } from '../dates'
import type { Report, ReportEntry, ReportInvoice, ReportMetric } from '../reports'

export const historicalHref = (customer: string, id: string) => `/app/customers/${customer}#history-${id}`
export async function customerHistory(env: Bindings, customer: string, includeOriginal = false) {
  const documents = await all(env, 'SELECT * FROM nc_incumbent_invoices WHERE customer_id=? ORDER BY COALESCE(issue_date,period_start),id', customer)
  const records = await all(env, 'SELECT * FROM nc_incumbent_history WHERE customer_id=? ORDER BY occurred_on,id', customer)
  return { totals:{invoicedCents:documents.filter(row=>row.document_kind==='invoice'&&['paid','open','uncollectible'].includes(row.status)).reduce((n,row)=>n+row.total_cents,0), creditedCents:documents.filter(row=>row.document_kind==='credit-note'&&row.status==='issued').reduce((n,row)=>n+row.total_cents,0),paymentsCents:records.filter(row=>row.kind==='payment'&&row.status==='succeeded').reduce((n,row)=>n+row.amount_cents,0),refundsCents:records.filter(row=>row.kind==='refund'&&row.status==='succeeded').reduce((n,row)=>n+row.amount_cents,0),remainingCents:documents.filter(row=>row.document_kind==='invoice'&&row.status==='open').reduce((n,row)=>n+row.remaining_cents,0)}, documents: documents.map(({source_json,lines_json,...row}) => ({ ...row, lines: publicLines(lines_json), ...(includeOriginal?{original:parseJson<Row>(source_json,{})}:{}) })), records: records.map(({payload_json,...row}) => ({ ...row, ...(includeOriginal?{original:parseJson<Row>(payload_json,{})}:row.kind==='subscription-event'?{original:subscriptionSnapshot(parseJson<Row>(payload_json,{}))}:{}) })) }
}
function publicLines(text:string) {
  const lines=parseJson<unknown>(text,[])
  return Array.isArray(lines)?lines.map(({price_source,...line}:Row)=>line):[]
}
function subscriptionSnapshot(event:Row) {
  const source=event.data?.object??{}
  const fields=['id','object','status','start_date','trial_start','trial_end','billing_cycle_anchor','canceled_at','ended_at','cancel_at','cancel_at_period_end','pause_collection']
  return {id:event.id,type:event.type,created:event.created,data:{object:{...Object.fromEntries(fields.filter(field=>source[field]!==undefined).map(field=>[field,source[field]])),items:{data:(source.items?.data??[]).map((item:Row)=>({id:item.id,quantity:item.quantity,price:typeof item.price==='string'?item.price:item.price?.id}))}}}}
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
    result.push({row,components,original,entry:{invoiceId:row.id,number:row.number||row.provider_ref,customerId:row.customer_id,customerName:row.customer_name,amountCents:amount,href:sourceHref(metric,row.id,month,customer,bucket),sourceKind:kind,sourceProvider:row.erased_at?'stripe':row.provider,sourceReference:row.erased_at?row.id:row.provider_ref}})
  }
  if(metric==='collections') {
    const payments=await all(env,`SELECT p.*,c.name AS customer_name,c.erased_at FROM nc_incumbent_history p JOIN nc_customers c ON c.id=p.customer_id WHERE p.kind='payment' AND p.status='succeeded' AND substr(p.occurred_on,1,7)=? AND p.occurred_on<=? ${customer?'AND p.customer_id=?':''} ORDER BY p.occurred_on,p.id`,month,day,...(customer?[customer]:[]))
    for(const row of payments)add(row,row.amount_cents,[{kind:'imported_payment',label:`${row.provider} payment ${row.provider_ref}`,amountCents:row.amount_cents,href:historicalHref(row.customer_id,row.id)}],parseJson<Row>(row.payload_json,{}),'payment')
    return result
  }
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
    const lines=parseJson<Row[]>(row.lines_json,[])
    if(metric==='billings'&&row.issue_date.slice(0,7)===month) {
      const components=row.erased_at?[{kind:'retained_consideration',label:'Retained original pretax invoice amount',amountCents:row.total_cents-row.tax_cents,href}]:lines.map((line,index)=>({kind:line.kind||'imported_line',label:`${row.provider}: ${line.description||line.source_id||`line ${index+1}`}`,amountCents:line.amount_cents,href}))
      components.push({kind:'tax',label:`${row.provider} original invoice tax`,amountCents:row.tax_cents,href})
      insist(components.reduce((sum,line)=>sum+line.amountCents,0)===row.total_cents,'historical_invoice_does_not_reconcile',409,{invoice:row.provider_ref})
      add(row,row.total_cents,components,original,'invoice')
    }
    if(metric==='tax'&&row.issue_date.slice(0,7)===month)add(row,row.tax_cents,[{kind:'tax',label:`${row.provider} original invoice tax`,amountCents:row.tax_cents,href}],original,'invoice')
    if(metric==='ar'&&row.status==='open'&&row.remaining_cents>0&&row.due_date&&(!bucket||(bucket==='overdue'?row.due_date<day:bucketOf(row.due_date,day)===bucket))) {
      add(row,row.remaining_cents,[{kind:'original',label:`${row.provider} original invoice`,amountCents:row.total_cents,href},{kind:'source_settlement',label:`${row.provider} recorded settlements and credits`,amountCents:row.remaining_cents-row.total_cents,href}],original,'invoice')
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
export async function historicalReportSource(env: Bindings, report: Report, id: string, url: URL, day: string, includeOriginal = false): Promise<ReportInvoice | null> {
  const entry=report.entries.find(row=>row.invoiceId===id)
  if(!entry?.sourceProvider)return null
  const sources=await historicalContributions(env,report.metric,report.period.slice(0,7),url.searchParams.get('customer'),day,url.searchParams.get('bucket'))
  const source=sources.find(row=>row.entry.invoiceId===id);insist(source,'report_invoice_not_found',404)
  const {row}=source
  return {...entry,metric:report.metric,title:report.title,definition:report.definition,period:report.period,totalCents:entry.amountCents,components:source.components,
    historical:{provider:row.erased_at?'stripe':row.provider,reference:row.erased_at?row.id:row.provider_ref,href:historicalHref(row.customer_id,row.id),original:includeOriginal?source.original:{provider:entry.sourceProvider,reference:entry.sourceReference,date:row.issue_date??row.occurred_on,status:row.status,amountCents:row.total_cents??row.amount_cents,taxCents:row.tax_cents??null}},
    invoice:report.metric==='collections'?null:{id:row.id,number:row.number,customerId:row.customer_id,customerName:row.customer_name,subscriptionId:row.subscription_id,issueDate:row.issue_date,dueDate:row.due_date,periodStart:row.period_start,periodEnd:row.period_end,currency:row.currency,status:row.status,totalCents:row.total_cents,taxCents:row.tax_cents}}
}
