import type { Bindings } from '../../auth.server'
import type { Actor } from '../actor'
import { dunningReport } from '../dunning'
import { all } from '../core'
import { h, page, form, hidden, field, select, check, table } from './html'
import { money } from '../decimal'

const back='/app/settings/dunning'
const statuses:Record<string,string>={active:'Active',settled:'Settled',historical:'Historical; authority withdrawn',withdrawn:'Withdrawn',keep_active:'Service kept active',mark_unpaid:'Marked unpaid',restrict:'Features restricted',cancel:'Cancellation recorded',prepared:'Prepared; needs confirmation',sending:'Send claimed; outcome unknown',accepted:'Provider accepted',uncertain:'Provider outcome uncertain',failed:'Send failed or mail unavailable',suppressed:'Development send suppressed',rejected:'Provider rejected',rate_limited:'Provider rate limited'}
const status=(value:string)=>statuses[value]??value
const actions=[{value:'keep_active',label:'Keep service active'},{value:'mark_unpaid',label:'Mark unpaid'},{value:'restrict',label:'Restrict features until settled'},{value:'cancel',label:'Cancel through subscription review'}]
export async function dunningPage(env: Bindings,actor: Actor,url: URL) {
 const report=await dunningReport(env,actor)
 const invoices=await all(env,`SELECT i.id,i.number,c.name FROM nc_invoices i JOIN nc_customers c ON c.id=i.customer_id
 WHERE i.status='issued' AND c.status='active' AND c.erased_at IS NULL AND NOT EXISTS(SELECT 1 FROM nc_dunning_series s WHERE s.invoice_id=i.id)
 AND (EXISTS(SELECT 1 FROM nc_retry_attempts r WHERE r.invoice_id=i.id AND r.outcome='failed') OR EXISTS(SELECT 1 FROM nc_native_collections n WHERE n.invoice_id=i.id AND n.status IN ('declined','customer_action_required'))) ORDER BY i.number`)
 const selected=report.series.find(s=>s.id===url.searchParams.get('series'))??report.series.at(-1)
 return page('Dunning sequences',actor,h`<h1>Dunning sequences</h1><p>Review each due message and confirm it once. Payment updates require the customer’s own consent.</p>
 <details class="card" id="dunning-policy"><summary>Policies and enrollment</summary>
 ${table(['Policy','Applies to','Days after failure','End action'],report.policies.map(p=>[p.name,p.scope==='default'?'Default':`${p.scope}: ${p.scope_ref}`,JSON.parse(p.offsets_json).join(', '),actions.find(a=>a.value===p.end_action)?.label]))}
 <h2>Create a policy</h2>${form('dunning.policy.create',back,h`${field('Policy name','name')}${select('Applies to','scope',[{value:'default',label:'Default'},{value:'plan',label:'Plan price'},{value:'segment',label:'Customer segment'}])}${field('Plan price or segment','scope_ref',{required:false})}${field('Email days after first failure','offsets',{value:'0,7,14,21'})}${field('Final action day','end_day',{type:'number',value:21})}${select('Final action','end_action',actions)}${check('Invoice-only messages; keep service active','invoice_only')}${check('I confirm these exact policy terms','confirm')}`,'Create policy')}
 ${invoices.length&&report.policies.length?h`<h2>Enroll a failed invoice</h2>${form('dunning.enroll',back,h`${select('Invoice','invoice',invoices.map(i=>({value:i.id,label:`${i.name} · ${i.number}`})))}${select('Policy','policy',report.policies.map(p=>({value:p.id,label:p.name})))}${check('I confirm this invoice and policy','confirm')}`,'Enroll invoice')}`:''}</details>
 <section class="card"><h2>Sequences</h2>${table(['Customer and invoice','Policy','Balance','Status'],report.series.map(s=>[h`<a href="${back}?series=${s.id}">${s.customerName} · ${s.invoiceNumber}</a>`,s.name,money(s.balanceCents),s.held?'On hold':status(s.status)]))}</section>
 ${selected?h`<section class="card" id="dunning-sequence"><h2>${selected.customerName} · ${selected.invoiceNumber}</h2><p>${selected.name} · ${status(selected.status)} · ${money(selected.balanceCents)}</p><p><a href="/app/invoices/${selected.invoice_id}">Open invoice and payment recovery</a></p>
 ${table(['Step','Scheduled date','Outcome'],selected.steps.map(s=>[s.step,s.due,selected.deliveries.find(d=>d.step===s.step)?.status?status(selected.deliveries.find(d=>d.step===s.step)!.status):(s.dueToday?'Due today':'Not sent')]))}
 ${selected.status==='active'&&!selected.held?selected.steps.filter(s=>s.dueToday&&!selected.deliveries.some(d=>d.step===s.step)).map(s=>form('dunning.mail.prepare',`${back}?series=${selected.id}`,h`${hidden('series',selected.id)}${hidden('step',s.step)}${check(`Prepare step ${s.step} for today with a fresh payment-update link`,'confirm')}`,'Prepare due message')):''}
 ${selected.status==='active'?form('dunning.withdraw',`${back}?series=${selected.id}`,h`${hidden('series',selected.id)}${check('Withdraw pending messages and their update links','confirm')}`,'Withdraw sequence'):''}
 ${selected.deliveries.map(d=>h`<article data-dunning-delivery="${d.id}"><h3>Step ${d.step} · ${status(d.status)}</h3><p>${d.recipient} · ${d.due_date} · ${money(d.amount_cents)}</p>${d.body?h`<p><strong>${d.subject}</strong></p><p class="dunning-message">${d.body}</p>`:''}
 ${selected.status==='active'&&!selected.held&&d.status==='prepared'&&d.body?form('dunning.mail.send',`${back}?series=${selected.id}`,h`${hidden('delivery',d.id)}${hidden('basis_hash',d.basis_hash)}${check('Send this exact message to this recipient once','confirm')}`,'Confirm message send'):''}<p>${d.provider_ref?`Provider accepted reference: ${d.provider_ref}`:d.claimed_at?'An attempt was claimed. No resend is available.':''}</p></article>`)}
 ${selected.status==='active'&&selected.end_action==='cancel'&&selected.day>=selected.endDue?h`<p><a href="/app/subscriptions/${selected.subscription}">Review and confirm subscription cancellation</a></p>`:''}
 ${selected.status==='active'&&!selected.held&&selected.day>=selected.endDue?form('dunning.end',`${back}?series=${selected.id}`,h`${hidden('series',selected.id)}${hidden('action',selected.end_action)}${check(`Confirm final action: ${actions.find(a=>a.value===selected.end_action)?.label}`,'confirm')}`,'Confirm final action'):''}</section>`:''}`,
 {current:'/app/settings',url})
}
