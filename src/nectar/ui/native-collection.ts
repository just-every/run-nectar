import type { Bindings } from '../../auth.server'
import type { Actor } from '../actor'
import { readNativeCollections } from '../payments/collection'
import { one, parseJson, type Row } from '../core'
import { cents as importedCents, check, field, form, h, hidden, type Html } from './html'

export async function nativeCollectionSection(env: Bindings, actor: Actor, invoice: Row): Promise<Html | string> {
  if (actor.kind !== 'member' || actor.role !== 'owner' || invoice.status !== 'issued' || invoice.retainedFinancial) return ''
  const cents=(value:number)=>importedCents(value,invoice.currency??'USD')
  const automatic = await one(env,'SELECT id,subscription_id,status FROM nc_prepaid_topup_claims WHERE invoice_id=?',invoice.id)
  if (automatic) return h`<section class="card" id="collection"><h2>Automatic prepaid purchase</h2><p>This invoice belongs to an authorized top-up crossing. Its existing payment outcome is ${automatic.status.replaceAll('_',' ')}.</p><p><a href="/app/prepaid/${automatic.subscription_id}">View the authorization and check its existing payment</a></p></section>`
  if(await one(env,"SELECT 1 FROM nc_automatic_collections WHERE invoice_id=? AND status NOT IN ('revoked','invalidated')",invoice.id))return ''
  const rows = (await readNativeCollections(env, actor, invoice.customer_id)).filter(row => row.invoice_id === invoice.id)
  const payer=await one(env,'SELECT p.payer_id,c.name FROM nc_invoice_payers p JOIN nc_customers c ON c.id=p.payer_id WHERE p.invoice_id=?',invoice.id)
  const route = parseJson<Row>(invoice.billing_route_json, {}), back = `/app/invoices/${invoice.id}`
  return h`<section class="card" id="collection"><h2>Collect this invoice</h2>
    ${payer?h`<p><strong>Parent payer: ${payer.name}.</strong> Payment will use the parent’s reviewed default card; the receipt remains allocated to this division’s invoice.</p>`:''}
    <p>One confirmed attempt charges the reviewed saved default card on this invoice’s original processor account. An uncertain result is checked without another charge. No receipt email is sent.</p>
    ${invoice.balanceCents > 0 && !rows.some(row=>row.status!=='pending') ? h`${form('collection.customer.bind',back,h`${hidden('customer',payer?.payer_id??invoice.customer_id)}${field('Processor account','account_ref',{value:route.processorAccountRef ?? ''})}${field('Stripe customer','stripe_customer_ref')}${check('I checked that this Stripe customer belongs to this billing customer on this account.','confirm')}`,'Confirm customer association',{secondary:true,layout:'columns'})}
      ${form('collection.prepare',back,h`${hidden('invoice',invoice.id)}`,'Review current card and balance',{secondary:true})}` : h`<p>${invoice.balanceCents>0?'The existing payment outcome is retained below. A new PaymentIntent cannot be created for this invoice.':'This invoice has no outstanding balance.'}</p>`}
    ${rows.map(row => h`<article><h3>${row.status === 'collected' ? 'Payment recorded' : row.status === 'pending' ? 'Review before charging' : row.status==='declined'?'Card declined':row.status==='customer_action_required'?'Customer authentication required':'Payment result uncertain'}</h3>
      <p>${cents(row.amount_cents)} · Account ${row.account_ref} · Customer ${row.stripe_customer_ref}</p>
      ${row.review ? h`<p>${row.review.card.brand} ending ${row.review.card.last4} · Expires ${row.review.card.expMonth}/${row.review.card.expYear}. Reviewed invoice ${row.review.invoiceNumber}.</p>` : ''}
      ${row.instructions.confirm && invoice.balanceCents > 0 ? form('collection.confirm',back,h`${Object.entries(row.instructions.confirm).filter(([key])=>key!=='confirm').map(([key,value])=>hidden(key,value))}${check(`Charge exactly ${cents(row.amount_cents)} to this reviewed card and account once.`,'confirm')}`,'Confirm one charge',{primary:true}) : ''}
      ${row.instructions.reconcile ? form('collection.reconcile',back,h`${hidden('request',row.id)}`,'Check existing payment',{secondary:true}) : ''}
      ${row.status === 'collected' ? h`<p>Payment ${row.payment_id}; processor reference ${row.payment_intent_ref}. Allocated to this original invoice.</p>` : ''}
      ${row.error_code ? h`<p class="hint">Processor outcome: ${row.error_code.replaceAll('_',' ')}. The invoice stays owed until a successful payment is proved. No second PaymentIntent will be created.</p>` : ''}
    </article>`)}
  </section>`
}
