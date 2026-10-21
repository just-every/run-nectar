import type { Row } from '../core'
import { area, check, form, h, hidden, select } from './html'

export function numberingSourceForms(revision: number, entities: Row[], customers: Row[], documents: Row[], sources: Row[]) {
  const entity = () => select('Entity for this capture','entity',entities.map(row=>({value:row.id,label:row.legal_name})),'',{required:false,blank:'Installation business / selected customer’s entity'})
  const scope = () => select('Customer sequence (optional)','customer',customers.map(row=>({value:row.id,label:row.name})),'',{required:false,blank:'Account-wide sequence'})
  const kinds = () => select('Document kind','kind',[{value:'invoice',label:'Invoice'},{value:'credit-note',label:'Credit note'}],'invoice')
  const original = (rows=documents) => select('Last captured document','source_invoice',rows.map(row=>({value:row.id,label:`${row.number} — ${row.name}`})))
  return h`<section class="card"><h2>Source numbering settings</h2>
    <p>Capture settings before applying a continuation. An account-settings record is your transcription of Stripe’s settings, with its observation time and evidence. It is labelled owner-recorded. The live customer read checks the connected Stripe account, customer settings and selected original invoice; it cannot read account-wide numbering settings.</p>
    ${documents.length ? h`<details><summary>Record observed settings</summary>
      <p>Supply JSON fields <code>account_ref</code>, <code>numbering_mode</code> (account or customer), <code>prefix</code> including its separator, <code>width</code>, <code>next_number</code>, <code>observed_at</code> with timezone and <code>evidence</code>. The next number must immediately follow the selected captured number.</p>
      ${form('invoice.series.capture','/app/numbering',h`${hidden('revision',revision)}${entity()}${scope()}${kinds()}${original()}
        ${area('Observed numbering settings (JSON)','capture')}${check('I recorded these exact settings from the previous biller. This is an owner observation.','confirm')}`,'Record source settings',{layout:'columns'})}</details>` : h`<p>Import source documents before recording their continuation settings.</p>`}
    ${documents.some(row=>row.document_kind==='invoice') ? h`<details><summary>Read live customer numbering</summary>
      ${form('invoice.series.capture-live','/app/numbering',h`${hidden('revision',revision)}${hidden('kind','invoice')}${entity()}
        ${select('Stripe customer to read','customer',customers.map(row=>({value:row.id,label:row.name})))}${original(documents.filter(row=>row.document_kind==='invoice'))}`,'Read customer settings from Stripe',{layout:'columns'})}</details>` : ''}
    ${sources.length ? form('invoice.series','/app/numbering',h`${hidden('revision',revision)}${hidden('mode','continue')}${entity()}${scope()}${kinds()}
      ${select('Captured settings to continue','source_capture',sources.map(row=>({value:row.id,label:`${row.prefix}${String(row.next_number).padStart(row.width,'0')} — ${row.capture_kind === 'live-customer-api' ? 'Stripe customer API' : 'Owner-recorded settings'}`})))}`,'Apply captured settings',{layout:'columns'}) : ''}
  </section>`
}
