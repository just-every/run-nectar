import type { Bindings } from '../../auth.server'
import { can, type Actor } from '../actor'
import { customers } from '../customers'
import { cashApplicationQueue } from '../cash-application-queue'
import { Input } from '../input'
import { openInvoices } from '../receivables'
import { previewRemittance, previewRemittanceAllocation, readRemittances } from '../remittances'
import { plainMoney } from '../decimal'
import { cents, check, field, fileField, form, h, hidden, select, table } from './html'

const reasons: Record<string,string> = { unidentified_customer: 'Customer needs identification', unmatched_reference: 'Invoice reference needs review',
  ambiguous_customer: 'Several customers share this identifier', awaiting_confirmation: 'Ready for confirmation',
  balance_requires_review: 'Advice exceeds a current invoice balance', short_payment: 'Short payment: invoice balance remains', unallocated_funds: 'Received funds await allocation',
  ambiguous_amount: 'Several invoices have this amount', unmatched_amount: 'No exact invoice amount', source_requires_review: 'Source needs review', allocated: 'Allocated' }
export async function cashApplicationPanel(env: Bindings, actor: Actor) {
  const rows = await cashApplicationQueue(env, actor)
  return h`<section class="card" id="cash-application-queue"><h2>Cash application queue</h2>
    ${table(['Received','Source','Customer','Unallocated','State','Review'], rows.map(row => [row.receivedOn,
      h`${row.source === 'processor_cash' ? 'Processor cash balance' : 'Remittance file'}<p>${row.sourceReference}</p>`,
      row.customerName,cents(row.unallocatedCents,row.currency),
      h`${row.status === 'staged' ? 'Awaiting receipt confirmation. ' : ''}${reasons[row.reason] ?? 'Needs allocation'}${row.daysLeft !== null ? h`<p>${row.ageDays} days old · ${row.daysLeft ? `${row.daysLeft} days until return deadline` : 'Return deadline reached'}</p><p>75-day processor deadline: ${row.returnDeadline?.slice(0,10)}</p>` : ''}`,
      h`<a href="${row.href}">${row.source === 'processor_cash' ? 'Review transfer' : 'Review receipt'}</a>`,
    ]), {empty:'No receipts or transfers need review.'})}</section>`
}
export async function remittancesPanel(env: Bindings, actor: Actor, url: URL) {
  const rows = await readRemittances(env, actor), operator = actor.kind === 'member' && can(actor, 'receivables')
  const back = '/app/receivables#remittances', selected = url.searchParams.get('remittance')
  const row = rows.find(row => row.id === selected), people = operator ? await customers(env, actor) : []
  let review = h``
  if (operator && row) {
    if (row.status === 'staged') {
      const customer = url.searchParams.get('remittance_customer') ?? ''
      const preview = await previewRemittance(env, actor, Input.of({ receipt: row.id, customer }))
      review = h`<article class="notice" id="remittance-review"><h3>Review receipt ${preview.source.receiptId}</h3>
        <p>${cents(preview.source.amountCents)} received ${preview.source.receivedOn}. ${reasons[preview.reason] ?? 'Exact remittance match'}. Nothing is recorded until you confirm.</p>
        ${table(['Invoice','Apply','Current balance','Balance after'], preview.allocations.map(a => [a.number,cents(a.amountCents),cents(a.balanceCents),cents(a.balanceCents-a.amountCents)]), {empty:'No invoice allocation is proposed.'})}
        <p>Unallocated after confirmation: ${cents(preview.unallocatedCents)}.</p>
        ${preview.customer ? form('remittance.confirm', back, h`${hidden('receipt', row.id)}${hidden('customer', preview.customer)}${hidden('fingerprint', preview.fingerprint)}${check('I confirm these received funds and the listed allocations', 'confirm')}`, 'Confirm received funds') : ''}
        <form method="get" action="/app/receivables">${hidden('remittance',row.id)}${select('Customer identified by a person','remittance_customer',people.filter(c=>c.status==='active').map(c=>({value:c.id,label:c.name})),customer,{blank:'Choose a customer'})}<button type="submit" class="secondary">Review identified customer</button></form></article>`
    } else if (row.available_cents > 0) {
      const invoices = await openInvoices(env, row.customer_id), invoice = url.searchParams.get('remittance_invoice'), amount = url.searchParams.get('remittance_amount') ?? ''
      let confirmation = h``
      if (invoice && amount) {
        const preview = await previewRemittanceAllocation(env, actor, Input.of({ receipt: row.id, invoice, amount }))
        confirmation = h`<p>Apply ${cents(preview.amountCents)} to ${preview.number}; balance after ${cents(preview.balanceCents-preview.amountCents)}. Unallocated after ${cents(preview.availableCents-preview.amountCents)}.</p>
          ${form('remittance.allocate', back, h`${hidden('receipt',row.id)}${hidden('invoice',invoice)}${hidden('amount',amount)}${hidden('fingerprint',preview.fingerprint)}${check('I confirm this exact allocation','confirm')}`, 'Confirm allocation')}`
      }
      review = h`<article class="notice" id="remittance-review"><h3>Allocate receipt ${row.source.receiptId}</h3><p>${row.customer_name}: ${cents(row.available_cents)} unallocated.</p>
        <form method="get" action="/app/receivables">${hidden('remittance',row.id)}${select('Invoice','remittance_invoice',invoices.map(i=>({value:i.id,label:`${i.number} · ${plainMoney(i.balance_cents)} owed`})),invoice??'')}${field('Amount ($)','remittance_amount',{value:amount})}<button type="submit" class="secondary">Preview allocation</button></form>${confirmation}</article>`
    }
  }
  return h`<section class="card" id="remittances"><h2>Remittance receipts</h2><p class="hint">Upload received USD lockbox funds, review matches, then confirm. This records cash received outside Nectar; it does not verify a bank transfer or charge a processor.</p>
    ${operator ? h`<details><summary>Upload a remittance file</summary><p>CSV columns: receipt_id, received_on, currency, amount, customer, invoice_reference, allocation_amount. Use a stable receipt ID, USD, an exact dollar amount and a YYYY-MM-DD date. Repeat the receipt total for each invoice row. Customer is its exact customer ID; invoice reference is the full invoice number. Leave the last two cells empty for an unidentified deposit.</p>
      ${form('remittance.upload',back,fileField('Remittance CSV','file',{required:true,accept:'.csv'}),'Upload for review',{multipart:true})}</details>` : ''}
    ${review}
    ${table(['Source receipt','Received','Customer','Amount','State','Review'],rows.map(row=>[row.source.receiptId,row.received_on,row.customer_name??'Unidentified',cents(row.amount_cents),row.status==='staged'?reasons[row.preview?.reason??row.reason]??'Ready for confirmation':reasons[row.reason],
      operator&&(row.status==='staged'||row.available_cents>0)?h`<a href="/app/receivables?remittance=${row.id}#remittance-review">Review receipt</a>`:h`${(row.short??[]).map((i:any)=>h`<p>${i.number}: ${cents(i.balance_cents)} still owed</p>`)}`]),{empty:'No remittance receipts uploaded.'})}</section>`
}
