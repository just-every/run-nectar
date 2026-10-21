import type { Bindings } from '../../auth.server'
import type { Actor } from '../actor'
import { requireBusiness } from '../business'
import { all } from '../core'
import { field, form, h, hidden, select } from './html'

export async function invoiceSeriesForms(env: Bindings, actor: Actor) {
  if (actor.role !== 'owner') return ''
  const b = await requireBusiness(env)
  const customers = await all(env, 'SELECT id,name,invoice_prefix,invoice_number_width,next_invoice_number FROM nc_customers WHERE erased_at IS NULL ORDER BY name,id')
  const invoices = await all(env, "SELECT i.id,i.number,c.name FROM nc_incumbent_invoices i JOIN nc_customers c ON c.id=i.customer_id WHERE i.number<>'' AND c.erased_at IS NULL ORDER BY i.number,i.id")
  const scope = () => select('Sequence scope', 'customer', customers.map(c => ({ value: c.id, label: c.name })), '', { required: false, blank: 'Business (account-level)' })
  return h`<section class="card"><h2>Invoice series</h2>
    <p>Business next: ${b.invoice_prefix}-${String(b.next_invoice_number).padStart(b.invoice_number_width,'0')}. Customer series take precedence for that customer.</p>
    ${customers.filter(c=>c.invoice_prefix).map(c=>h`<p>${c.name}: ${c.invoice_prefix}${String(c.next_invoice_number).padStart(c.invoice_number_width,'0')}</p>`)}
    <p>Continue from the last retained invoice in a captured series, or start an unused prefix at 1. This records your choice; it does not read or verify live processor settings. Credit-note continuation and multiple entities are not available. Changing a series invalidates saved invoice approvals.</p>
    ${invoices.length ? form('invoice.series','/app/numbering',h`${hidden('revision',b.revision)}${hidden('mode','continue')}${scope()}
      ${select('Last captured invoice', 'source_invoice', invoices.map(i=>({value:i.id,label:`${i.number} — ${i.name}`})),invoices[0].id)}`, 'Continue captured invoice series', { layout:'columns' }) : h`<p>Move in captured invoices before continuing a series.</p>`}
    ${form('invoice.series','/app/numbering',h`${hidden('revision',b.revision)}${hidden('mode','new')}${scope()}
      ${field('New invoice prefix','prefix',{hint:'Letters, digits and dashes. A trailing dash separates the number.'})}
      ${field('Minimum number digits','width',{type:'number',value:6,hint:'1–12 digits; 4 starts with 0001.'})}`, 'Start new invoice series', { layout:'columns' })}
  </section>`
}
