import type { Bindings } from '../auth.server'
import { requireCapability, type Actor } from './actor'
import { readPrepaidRefunds } from './prepaid-refund-records'
import { csvResponse } from './report-csv'

/** Export only typed custody, even when an approver downloads it. */
export async function prepaidRefundCsv(env:Bindings,actor:Actor,url:URL){
  requireCapability(actor,'export')
  const keys=['id','status','grant','subscription','customer','invoice','purchaseNumber','purchaseLine','payment','receiptReference','amountN','amountCents','kind','unitLabel','credit','creditNumber','refundRef','reasonCategory','preparedBy','approvedBy','approvalMode','preparedAt','approvedAt','claimedAt','refundedOn','cashAmountCents','liabilityCents','recognitionCents','source'] as const
  const customer=url.searchParams.get('customer'),facts=(await readPrepaidRefunds(env,actor,url.searchParams.get('subscription')??undefined)).filter(row=>!customer||row.customer===customer)
  const cell=(value:unknown)=>{const text=String(value??''),safe=/^[=+\-@\t\r]/.test(text)?`'${text}`:text;return /[",\r\n]/.test(safe)?`"${safe.replaceAll('"','""')}"`:safe}
  return csvResponse([keys,...facts.map(row=>keys.map(key=>row[key]))].map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n','nectar-prepaid-refunds')
}
