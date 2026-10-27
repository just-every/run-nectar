import type { Bindings } from '../auth.server'
import { canRead, type Actor } from './actor'
import { all, insist, type Row } from './core'
import { addDays, addMonths, localDate, zonedStart } from './dates'
import { reportingTotal, translateReportAmount, translateReportComponents } from './currency-report-translation'
import type { Report, ReportComponent, ReportEntry } from './reports'

export interface ProcessorCashReturnEvidence {
 request:string;refundRef:string;accountRef:string;customerRef:string;customerId:string;
 amountCents:number;currency:string;status:'succeeded';providerCreatedAt:number;successObservedAt:number;
 preparedBy:string;approvedBy:string
}
export interface ProcessorCashReturnReportEntry extends ReportEntry {cashReturn:ProcessorCashReturnEvidence}

/** Only verified successful returns contribute cash. Reservation, pending and
 * requested bank details remain outside refund totals. */
export async function processorCashReturnSources(env:Bindings,month:string,customer:string|null,day:string,timezone:string) {
 const rows=await all(env,`SELECT r.*,c.name AS customer_name,c.erased_at FROM nc_processor_cash_returns r JOIN nc_customers c ON c.id=r.customer_id
 WHERE r.status='succeeded' AND r.refund_ref IS NOT NULL AND r.completed_at>=? AND r.completed_at<? ${customer?'AND r.customer_id=?':''} ORDER BY r.completed_at,r.id`,
 zonedStart(`${month}-01`,timezone),Math.min(zonedStart(addMonths(`${month}-01`,1),timezone),zonedStart(addDays(day,1),timezone)),...(customer?[customer]:[]))
 const sources=new Map<string,{entry:ProcessorCashReturnReportEntry;cashReturn:ProcessorCashReturnEvidence;row:Row}>()
 for(const r of rows){
  insist(Number.isSafeInteger(r.amount_cents)&&r.amount_cents>0&&Number.isSafeInteger(r.provider_created_at)&&r.prepared_by_id&&r.approved_by_id,'processor_cash_return_report_invalid',409)
  const cashReturn:ProcessorCashReturnEvidence={request:r.id,refundRef:r.refund_ref,accountRef:r.account_ref,customerRef:r.stripe_customer_ref,customerId:r.customer_id,amountCents:-r.amount_cents,currency:r.currency,status:'succeeded',providerCreatedAt:r.provider_created_at,successObservedAt:r.completed_at,preparedBy:r.prepared_by_id,approvedBy:r.approved_by_id}
  const query=new URLSearchParams({period:month});if(customer)query.set('customer',customer)
  const entry:ProcessorCashReturnReportEntry={invoiceId:r.id,number:r.refund_ref,customerId:r.customer_id,customerName:r.erased_at?'Erased customer':r.customer_name,
   ...await translateReportAmount(env,r.currency,-r.amount_cents,localDate(r.completed_at,timezone)),sourceKind:'processor_refund',sourceProvider:'stripe',sourceReference:r.refund_ref,
   sourcePath:`/app/processor-events?customer=${r.customer_id}`,href:`/app/reports/refunds/${encodeURIComponent(r.id)}?${query}`,cashReturn}
  sources.set(r.id,{entry,cashReturn,row:r})
 }
 return sources
}
export function processorCashReturnSource(view:Pick<Report,'metric'|'title'|'definition'|'period'>,source:{entry:ProcessorCashReturnReportEntry;cashReturn:ProcessorCashReturnEvidence;row:Row},actor:Actor) {
 const {entry,cashReturn,row}=source
 const components:ReportComponent[]=[{kind:'customer_cash_return',label:'Successful return of unapplied cash · observed provider success',amountCents:cashReturn.amountCents,
  ...(!row.erased_at&&canRead(actor,'payments')?{href:entry.sourcePath}:{})}]
 const translated=translateReportComponents(entry,components)
 insist(reportingTotal(translated)===entry.amountCents,'processor_cash_return_report_changed',409)
 return {...entry,metric:view.metric,title:view.title,definition:view.definition,period:view.period,totalCents:entry.amountCents,components:translated,invoice:null,cashReturn}
}
