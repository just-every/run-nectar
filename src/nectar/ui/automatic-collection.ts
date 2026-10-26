import type { Bindings } from '../../auth.server'
import type { Actor } from '../actor'
import { automaticCollections } from '../automatic-collection-records'
import { requireBusiness } from '../business'
import { clockInstant } from '../clock'
import { localDate } from '../dates'
import type { Row } from '../core'
import { cents,check,field,form,h,hidden } from './html'
export async function automaticCollectionSection(env:Bindings,actor:Actor,invoice:Row){
 if(actor.kind!=='member'||!['owner','finance'].includes(actor.role??'')||invoice.retainedFinancial)return ''
 const rows=(await automaticCollections(env,actor,invoice.customer_id)).filter(row=>row.invoice===invoice.id),back=`/app/invoices/${invoice.id}`
 const date=localDate(clockInstant(env),(await requireBusiness(env)).timezone)
 return h`<section class="card" id="automatic-collection"><h2>Automatic collection</h2>
 ${['draft','approved'].includes(invoice.status)&&actor.role==='owner'&&!rows.some(row=>!['revoked','invalidated'].includes(row.status))?h`<details><summary>Set this invoice to auto-charge</summary><p>Review one exact collection. The customer accepts the terms in their signed-in portal, then a human approves. Saving a method alone never authorizes a debit.</p>${form('automatic.collection.prepare',back,h`${hidden('invoice',invoice.id)}${field('Collection date','issue_date',{type:'date',value:date})}${field('ACH mandate reference, for bank payments','mandate_ref',{required:false})}`,'Review collection',{secondary:true})}</details>`:''}
 ${rows.length?'':h`<p>Send invoice: payment waits until the customer pays. No automatic charge is authorized.</p>`}
 ${rows.map(row=>h`<article><h3>${row.historical?'Historical · ':''}${row.status.replaceAll('_',' ')}</h3>${row.historical&&!row.claimedAt?h`<p>Retained terms authorize no new debit. Withdraw these terms and prepare fresh customer consent and approval before collection.</p>`:''}<p>${cents(row.amountCents)} · ${row.quote.method.summary.brand} ending ${row.quote.method.summary.last4} · ${row.quote.issueDate}</p>
 ${row.status==='awaiting_customer'?h`<p>The customer can accept this exact invoice at <strong>/portal/automatic-collections/${row.id}</strong> with their current hosted portal session.</p>`:''}
 ${row.status==='pending_approval'?form('automatic.collection.decide',back,h`${hidden('request',row.id)}${hidden('basis_hash',row.basis)}${hidden('decision','approved')}${check('I approve these exact terms after customer acceptance.','confirm')}${actor.role==='owner'?check('I am the only authorized approver and explicitly confirm this collection.','confirm_single'):''}`,'Approve automatic collection',{secondary:true}):''}
 ${['awaiting_customer','pending_approval','active'].includes(row.status)&&actor.role==='owner'?form('automatic.collection.revoke',back,hidden('request',row.id),'Withdraw collection',{secondary:true}):''}
 ${['claimed','uncertain','pending_settlement'].includes(row.status)&&actor.role==='owner'?form('automatic.collection.reconcile',back,hidden('request',row.id),'Check existing payment',{secondary:true}):''}
 ${row.paymentIntentRef?h`<p>Processor reference ${row.paymentIntentRef}. ${row.payment?h`<a href="/app/payments/${row.payment}/receipt">Payment receipt</a>`:row.status==='pending_settlement'?'The invoice remains owed while settlement is pending.':row.status==='returned'?'The bank payment returned. The invoice remains owed.':'No collected payment is confirmed. The invoice remains owed.'}</p>`:''}
 ${row.errorCode?h`<p role="status">${row.errorCode.replaceAll('_',' ')}. Check the existing outcome; another charge is never sent.</p>`:''}</article>`)}</section>`
}
