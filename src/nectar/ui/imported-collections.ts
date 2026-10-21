// Original-source collection sits beside its read-only history, never in the
// native invoice approval forms.
import type { Actor } from '../actor'
import { cents,check,details,form,h,hidden,select,tag } from './html'
export function importedCollectionsSection(customer:any,actor:Actor) {
  const requests=customer.importedCollections??[],owner=actor.kind==='member'&&actor.role==='owner'
  const sources=customer.incumbentHistory.documents.filter((row:any)=>row.provider==='stripe'&&row.document_kind==='invoice'&&row.status==='open'&&row.remaining_cents>0&&!requests.some((request:any)=>request.invoice_id===row.id))
  if(!requests.length&&!sources.length)return ''
  return h`<section class="card"><h2>Collect original Stripe invoices</h2><p>Choose and confirm each original open invoice. Nectar stops Stripe’s automatic collection before making one Nectar payment attempt, then waits for your separate confirmation to mark the original paid out of band. Paid and void invoices cannot be collected here. An uncertain result can only be checked with Stripe.</p>
    ${owner&&sources.length?(customer.importedCollectionConfigured?form('imported.collection.prepare',`/app/customers/${customer.id}`,h`${select('Original open invoice','invoice',sources.map((row:any)=>({value:row.id,label:`${row.number} · ${cents(row.remaining_cents)}`})))}`,'Review original invoice') :h`<p>Stripe collection is not configured for this installation.</p>`):''}
    ${requests.map((request:any)=>h`<article><h3>${request.number} · ${cents(request.amount_cents)}</h3><p>${tag(request.status==='uncertain'&&request.charge_ref?'Mirror pending':request.status)}${request.collected_on?h` · Collected ${request.collected_on}`:''}</p>
      ${owner&&request.review?h`<p>Stripe account ${request.account_ref}. Original invoice ${request.invoice_ref}; ${request.currency.toUpperCase()} ${cents(request.amount_cents)}.</p>`:''}
      ${owner&&request.review?.principal===actor.id&&request.instructions?.execute?form('imported.collection.execute',`/app/customers/${customer.id}`,h`${hidden('request',request.id)}${hidden('basis_hash',request.basis_hash)}${check('Stop Stripe automatic collection for this invoice','disable_auto_advance')}${check('I authorize one payment attempt for this exact invoice and amount','confirm')}`,'Collect reviewed invoice'):''}
      ${owner&&request.review?.principal===actor.id&&request.instructions?.reconcile?form('imported.collection.reconcile',`/app/customers/${customer.id}`,hidden('request',request.id),'Check Stripe payment result',{secondary:true}):''}
      ${owner&&request.instructions?.finalize?form('imported.collection.finalize',`/app/customers/${customer.id}`,h`${hidden('request',request.id)}${check('I confirm marking the original paid out of band for this verified charge','confirm')}`,'Complete paid status in Stripe',{secondary:true}):''}
      ${request.status==='uncertain'?h`<p>${request.charge_ref?'The charge is proven. The original Stripe invoice still needs a separately confirmed paid status.':'The payment result is not confirmed.'} No automatic retry or mirror will run.</p>`:''}
      ${owner&&request.charge_ref?details({invoice:request.invoice_ref,payment:request.payment_ref,charge:request.charge_ref,custody:request.custody},'Payment source references'):''}
    </article>`)}
  </section>`
}
