import type { Bindings } from '../../auth.server'
import type { Row } from '../core'
import { area, check, field, form, h, hidden, select } from './html'

const identity = (entity?: Row) => h`${field('Legal name','legal_name',{value:entity?.legal_name ?? ''})}${area('Legal address','address',entity?.address ?? '')}
  ${field('EIN','ein',{value:entity?.ein ?? '',hint:'US EIN, for example 12-3456789.'})}
  ${field('Payment terms (days)','payment_terms_days',{type:'number',value:entity?.payment_terms_days ?? 30})}
  ${field('Stripe account reference','processor_account_ref',{value:entity?.processor_account_ref ?? '',hint:'Account identifier only. Credentials stay in installation secrets.'})}
  ${field('Accounting company reference','ledger_company_ref',{value:entity?.ledger_company_ref ?? ''})}
  ${field('Tax registration','tax_registration',{value:entity?.tax_registration ?? ''})}`

export function numberingEntityForms(_env: Bindings, revision: number, entities: Row[], customers: Row[]) {
  return h`<section class="card"><h2>Billing entities</h2>
    <p>Record each legal identity and its intended processor and accounting company. These references do not connect an account, collect a payment or post a journal. Invoice and credit numbers use the selected entity; issued routing snapshots remain unchanged after an edit.</p>
    <details><summary>Add a legal entity</summary>${form('entity.create','/app/numbering',h`${hidden('revision',revision)}${identity()}
      ${field('Unused invoice prefix','invoice_prefix',{hint:'A new series starts at 1. Continue captured numbering after creating the entity.'})}
      ${field('Minimum invoice digits','invoice_number_width',{type:'number',value:4})}`, 'Record billing entity',{layout:'columns'})}</details>
    ${entities.map(entity=>h`<details><summary>${entity.legal_name} · ${entity.invoice_prefix}${String(entity.next_invoice_number).padStart(entity.invoice_number_width,'0')}</summary>
      <p>Credit next: ${entity.credit_prefix}${String(entity.next_credit_number).padStart(entity.credit_number_width,'0')}.</p>
      ${form('entity.update','/app/numbering',h`${hidden('revision',revision)}${hidden('entity',entity.id)}${identity(entity)}`,'Save entity identity and routes',{layout:'columns'})}</details>`)}
    ${entities.length && customers.length ? form('customer.entity','/app/numbering',h`${hidden('revision',revision)}
      ${select('Customer to assign','customer',customers.map(customer=>({value:customer.id,label:customer.name})))}
      ${select('Billing entity','entity',entities.map(entity=>({value:entity.id,label:entity.legal_name})))}
      ${check('Assign this entity and clear the customer’s previous number overrides. Assignment is fixed after Nectar issues a document.','confirm')}`,'Assign customer entity',{layout:'columns'}) : ''}
  </section>`
}
