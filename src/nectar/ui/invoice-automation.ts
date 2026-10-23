import type { Bindings } from '../../auth.server'
import { can, type Actor } from '../actor'
import { all } from '../core'
import { invoiceAutomation } from '../invoice-automation'
import { check,field,form,h,hidden,table,tag } from './html'

export async function invoiceAutomationSection(env: Bindings, actor: Actor) {
  const policy=await invoiceAutomation(env),requests=await all(env,"SELECT * FROM nc_invoice_automation_requests ORDER BY prepared_at DESC,id LIMIT 30")
  return h`<section class="card" aria-labelledby="invoice-automation"><h2 id="invoice-automation">Automatic clean invoices</h2>
    <p>${tag(policy.enabled?'Enabled':'Off')} · Daily from ${String(policy.hour).padStart(2,'0')}:00 in the business billing timezone.</p>
    <p class="hint">Only drafts with no exceptions issue. Every exception waits for review. This policy sends no invoice email and charges no payment method. Each business day is attempted once; after an interrupted attempt, review the run before the next day.</p>
    ${actor.role==='owner'?form('invoice.automation.prepare','/app/billing#invoice-automation',h`${check('Enable automatic issue of clean invoices','enabled',{checked:!!policy.enabled})}${field('Business-local hour','hour',{type:'number',value:policy.hour})}`,'Prepare policy change',{secondary:true}):''}
    ${requests.filter(row=>row.status==='pending').map(row=>h`<article><h3>Pending: ${row.enabled?'enable':'disable'} automatic issue at ${String(row.hour).padStart(2,'0')}:00</h3>
      ${can(actor,'approve')?h`${form('invoice.automation.decide','/app/billing#invoice-automation',h`${hidden('request',row.id)}${hidden('decision','approved')}${row.prepared_by===actor.id?check('I confirm this policy as the sole approver, with no other active owner or finance approver','confirm_single'):''}`,'Approve exact policy',{secondary:true})}
      ${form('invoice.automation.decide','/app/billing#invoice-automation',h`${hidden('request',row.id)}${hidden('decision','rejected')}`,'Reject policy',{secondary:true})}`:''}</article>`)}
    ${table(['Business day','Outcome','Issued','Needs review'],(await all(env,'SELECT business_day,status,result_json FROM nc_invoice_automation_runs ORDER BY business_day DESC LIMIT 30')).map(row=>{const result=JSON.parse(row.result_json);return [row.business_day,tag(row.status),(result.issued??[]).length,(result.review??[]).length]}),{empty:'No automatic invoice run yet.'})}
  </section>`
}
