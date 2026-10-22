// Typed, source-linked ledger projections. Reads never grant, expire or charge.
import type { Bindings } from '../auth.server'
import { requireRead, requireCapability, can, type Actor } from './actor'
import { all, insist, one, parseJson } from './core'
import { requireDate, today } from './dates'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { decimalText, plainMoney } from './decimal'
import { csvResponse } from './report-csv'
import { lotStates } from './prepaid-math'
import { prepaidSnapshot } from './prepaid-records'
export async function prepaidState(env: Bindings, actor: Actor, subscription: string, at?: string) {
  requireRead(actor,'subscriptions'); requireRead(actor,'invoices')
  const sub=await one(env,'SELECT s.id,c.erased_at FROM nc_subscriptions s JOIN nc_customers c ON c.id=s.customer_id WHERE s.id=?',subscription)
  insist(sub,'subscription_not_found',404); insist(!sub.erased_at,'customer_erased',410)
  const date=requireDate(at || today((await requireBusiness(env)).timezone,clockInstant(env)), 'date'), recorded=await prepaidSnapshot(env,subscription)
  if (!recorded) return {subscription,date,revision:0,grants:[],entries:[],balances:[],requests:[],consents:[],fundingIntents:[]}
  const basis={...recorded,entries:recorded.entries.filter(entry=>entry.serviceDate<=date)}
  // A future grant is not a negative balance; it has no effective grant entry.
  basis.grants=basis.grants.filter(grant=>grant.effectiveDate<=date)
  const grants=lotStates(basis).map(lot=>({...lot.grant,remainingN:lot.remainingN,liabilityCents:lot.liabilityCents,availableN:lot.grant.expiresDate&&lot.grant.expiresDate<=date?0:lot.remainingN,expiryPending:!!lot.grant.expiresDate&&lot.grant.expiresDate<=date&&lot.remainingN>0}))
  const balances=new Map<string,{kind:string;meterId:string|null;remainingN:number;availableN:number;liabilityCents:number}>()
  for(const grant of grants){const key=`${grant.kind}:${grant.meterId??''}`,row=balances.get(key)??{kind:grant.kind,meterId:grant.meterId,remainingN:0,availableN:0,liabilityCents:0};row.remainingN+=grant.remainingN;row.availableN+=grant.availableN;row.liabilityCents+=grant.liabilityCents;balances.set(key,row)}
  const requests=can(actor,'approve')?await all(env,'SELECT id,kind,status,payload_json,prepared_by,prepared_at,approval_mode FROM nc_prepaid_requests WHERE subscription_id=? ORDER BY prepared_at,id',subscription):[]
  const consents=await all(env,'SELECT id,threshold_n,status,terms_json,approved_at,revoked_at FROM nc_prepaid_consents WHERE subscription_id=? ORDER BY approved_at,id',subscription)
  const intents=await all(env,'SELECT id,consent_id,amount_cents,invoice_id,status,created_at,funded_at,payment_id FROM nc_prepaid_funding_intents WHERE subscription_id=? ORDER BY created_at,id',subscription)
  return {subscription,date,revision:recorded.revision,grants,entries:basis.entries.map(entry=>({...entry,href:`/app/prepaid/${subscription}/entries/${encodeURIComponent(entry.id)}`})),balances:[...balances.values()],requests:requests.map(row=>({...row,payload:parseJson(row.payload_json,{}),payload_json:undefined})),consents:consents.map(row=>({...row,terms:parseJson(row.terms_json,{}),terms_json:undefined})),fundingIntents:intents}
}
export async function prepaidSource(env: Bindings, actor: Actor, subscription: string, id: string) {
  const state=await prepaidState(env,actor,subscription), entry=state.entries.find(entry=>entry.id===id)
  insist(entry,'prepaid_entry_not_found',404)
  const grant=state.grants.find(grant=>grant.id===entry.grantId)
  insist(grant,'prepaid_grant_not_found',404)
  const funding=grant.purchaseInvoice?await one(env,'SELECT invoice_id,payment_id,provider_ref,amount_cents,funded_at FROM nc_prepaid_funding_intents WHERE invoice_id=? AND status=\'funded\'',grant.purchaseInvoice):null
  return {entry,grant,funding,purchaseSource:grant.purchaseInvoice?`/app/invoices/${grant.purchaseInvoice}/lines/${grant.purchaseLine}`:null,serviceSource:entry.invoiceId?`/app/invoices/${entry.invoiceId}`:null}
}
export async function prepaidCsv(env: Bindings, actor: Actor, subscription: string) {
  requireCapability(actor,'export')
  const state=await prepaidState(env,actor,subscription)
  const rows:unknown[][]=[['entry_id','grant_id','kind','service_date','denomination','meter_id','signed_quantity','liability_change','recognized','purchase_invoice','purchase_line','service_invoice','source_path']]
  for(const entry of state.entries){const grant=state.grants.find(grant=>grant.id===entry.grantId)!;rows.push([entry.id,entry.grantId,entry.kind,entry.serviceDate,grant.kind,grant.meterId,grant.kind==='money'?plainMoney(entry.amountN):decimalText(BigInt(entry.amountN)),plainMoney(entry.liabilityCents),plainMoney(entry.recognitionCents),entry.purchaseInvoice,entry.purchaseLine,entry.invoiceId,entry.href])}
  const cell=(value:unknown)=>{const text=String(value??''),safe=/^[=+\-@\t\r]/.test(text)?`'${text}`:text;return /[",\r\n]/.test(safe)?`"${safe.replaceAll('"','""')}"`:safe}
  return csvResponse(rows.map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n','nectar-prepaid')
}
/** Parent revenue adapter uses ONLY the original purchase source. Redemption
 * discount lines cancel the service consideration; these valued entries earn
 * the purchased consideration once, including exact final-unit rounding. */
export async function prepaidPurchaseRecognition(env: Bindings, invoice: string) {
  return (await all(env,"SELECT id,subscription_id,grant_id,service_date,recognition_cents,invoice_id,purchase_line_id,kind FROM nc_prepaid_ledger WHERE purchase_invoice_id=? AND recognition_cents>0 ORDER BY service_date,id",invoice)).map(row=>({id:row.id,grantId:row.grant_id,date:row.service_date,period:row.service_date.slice(0,7),amountCents:row.recognition_cents,serviceInvoice:row.invoice_id,purchaseLine:row.purchase_line_id,kind:row.kind,source:`/app/prepaid/${row.subscription_id}/entries/${encodeURIComponent(row.id)}`}))
}
