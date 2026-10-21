import type { Bindings } from '../../auth.server'
import type { Actor } from '../actor'
import { requireBusiness } from '../business'
import { all } from '../core'
import { field, form, h, hidden, select } from './html'
import { numberingEntityForms } from './numbering-entities'
import { numberingSourceForms } from './numbering-sources'

export async function invoiceSeriesForms(env: Bindings, actor: Actor) {
  if (actor.role !== 'owner') return ''
  const b = await requireBusiness(env)
  const customers = await all(env, 'SELECT id,name,billing_entity_id,invoice_prefix,invoice_number_width,next_invoice_number,credit_prefix,credit_number_width,next_credit_number FROM nc_customers WHERE erased_at IS NULL ORDER BY name,id')
  const invoices = await all(env, "SELECT i.id,i.number,i.document_kind,c.name FROM nc_incumbent_invoices i JOIN nc_customers c ON c.id=i.customer_id WHERE i.number<>'' AND c.erased_at IS NULL ORDER BY i.number,i.id")
  const entities = await all(env, 'SELECT * FROM nc_billing_entities ORDER BY legal_name,id')
  const sources = await all(env, 'SELECT * FROM nc_numbering_sources ORDER BY captured_at,id')
  const customerSeries = await all(env, 'SELECT n.*,c.name FROM nc_entity_customer_numbers n JOIN nc_customers c ON c.id=n.customer_id WHERE c.erased_at IS NULL ORDER BY c.name,n.kind')
  const entity = () => select('Entity sequence','entity',entities.map(row=>({value:row.id,label:row.legal_name})),'',{required:false,blank:'Installation business / selected customer’s entity'})
  const scope = () => select('Sequence scope', 'customer', customers.map(c => ({ value: c.id, label: c.name })), '', { required: false, blank: 'Business (account-level)' })
  return h`<section class="card"><h2>Document series</h2>
    <p>Business next: ${b.invoice_prefix}-${String(b.next_invoice_number).padStart(b.invoice_number_width,'0')}. Customer series take precedence for that customer.</p>
    <p>Business next credit: ${b.credit_prefix ?? b.invoice_prefix + '-CN-'}${String(b.next_credit_number).padStart(b.credit_number_width,'0')}.</p>
    ${customers.filter(c=>c.invoice_prefix).map(c=>h`<p>${c.name}: ${c.invoice_prefix}${String(c.next_invoice_number).padStart(c.invoice_number_width,'0')}</p>`)}
    ${customers.filter(c=>c.credit_prefix).map(c=>h`<p>${c.name} credit: ${c.credit_prefix}${String(c.next_credit_number).padStart(c.credit_number_width,'0')}</p>`)}
    ${customerSeries.map(row=>h`<p>${row.name} ${row.kind}: ${row.prefix}${String(row.next_number).padStart(row.width,'0')}</p>`)}
    <p>Continue from the last retained document in a captured series, or start an unused prefix at 1. Captured credit notes continue independently. Settings captures below retain their provenance. Changing a series invalidates saved invoice approvals.</p>
    ${invoices.length ? form('invoice.series','/app/numbering',h`${hidden('revision',b.revision)}${hidden('mode','continue')}${entity()}${scope()}
      ${select('Document kind','kind',[{value:'invoice',label:'Invoice'},{value:'credit-note',label:'Credit note'}],'invoice')}
      ${select('Last captured document', 'source_invoice', invoices.map(i=>({value:i.id,label:`${i.number} — ${i.document_kind === 'credit-note' ? 'credit note' : 'invoice'} — ${i.name}`})),invoices[0].id)}`, 'Continue captured series', { layout:'columns' }) : h`<p>Move in captured documents before continuing a series.</p>`}
    ${form('invoice.series','/app/numbering',h`${hidden('revision',b.revision)}${hidden('mode','new')}${entity()}${scope()}
      ${select('Document kind','kind',[{value:'invoice',label:'Invoice'},{value:'credit-note',label:'Credit note'}],'invoice')}
      ${field('New document prefix','prefix',{hint:'Letters, digits and dashes. A trailing dash separates the number.'})}
      ${field('Minimum number digits','width',{type:'number',value:6,hint:'1–12 digits; 4 starts with 0001.'})}`, 'Start new series', { layout:'columns' })}
  </section>${numberingSourceForms(b.revision,entities,customers,invoices,sources)}${numberingEntityForms(env,b.revision,entities,customers)}`
}
