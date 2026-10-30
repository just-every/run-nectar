import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// INV-004: invoice content, customer presentation and downloadable PDF. All writes use public JSON or ordinary HTML forms.
export async function invoiceContentFlow(h, owner, { onState } = {}) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  const business = await api('business')
  const configure = fields => api('business.configure', { ...business, revision: fields.revision ?? business.revision, ...fields })
  const logo=(await readFile(new URL('../fixtures/invoice-logo.jpg',import.meta.url))).toString('base64')
  const branding={color:'#245c46',footer:'Thank you, Cedar customers.',remitTo:'Cedar Treasury, 14 Pine Street',logo}
  await configure({ invoice_fields: { 'Vendor ID': 'V-104' },invoice_branding:branding })
  await api('business.configure',{...await api('business'),invoice_branding:{...branding,color:'red;display:none'}},400)
  await h.api('access.give', owner, { email: 'inv004-finance@example.test', name: 'Invoice Finance', role: 'finance' })
  await h.api('access.give', owner, { email: 'inv004-accountant@example.test', name: 'Invoice Accountant', role: 'accountant' })
  const finance = await h.signIn('inv004-finance@example.test', { requested: true })
  const accountant = await h.signIn('inv004-accountant@example.test', { requested: true })
  const agent = { bearer: (await api('credential.issue', { name: 'INV-004 order preparer', scopes: ['prepare'] })).key }
  const settings = { paymentTermsDays: 45, poRequired: true, poNumber: '', memo: 'Please quote our purchase order.', customFields: { 'Cost center': 'Research West' } }
  const create = async (suffix, invoice_settings) => (await api('customer.create', { external_id: `INV004-${suffix}`, name: `Cedar ${suffix}`, billing_email: `${suffix.toLowerCase()}@invoice.example`, invoice_settings })).id
  const first = await create('FIRST', settings), second = await create('SECOND', {})
  const update = async (customer, invoice_settings, who = owner, status) => {
    const c = await api(`customers/${customer}`)
    return h.api('customer.update', who, { customer, revision: c.revision, name: c.name, billing_email: c.billing_email, invoice_settings }, status)
  }
  const product = (await api('product.create', { code: 'inv004-service', name: 'Invoice content service' })).id
  const price = (await api('price.create', { product, kind: 'flat', unit_amount: '100', taxable: false })).id
  for (const customer of [first, second]) await api('subscription.create', { customer, start_date: '2026-08-01', price: [price] })
  const prepare = async period => {
    const run = await api('billrun.prepare', { period })
    return { run, invoices: (await api(`runs/${run.id}`)).invoices }
  }
  let prepared = await prepare('2026-08')
  let blocked = prepared.invoices.find(i => i.customer_id === first)
  const exception = (await api(`invoices/${blocked.id}`)).exceptions.find(e => e.code === 'po_required')
  assert.ok(exception, 'INV-004 a required missing PO is a blocking exception')
  await api('invoice.approve', { invoice: blocked.id, acknowledge: true }, 409)
  await api('invoice.finalise', { invoice: blocked.id, issue_date: '2026-09-01' }, 409)
  await onState?.({ label: 'po-missing', path: `/app/invoices/${blocked.id}`, owner, first })
  for (const who of [agent, accountant]) await update(first, { ...settings, poNumber: 'ILLEGAL' }, who, 403)
  await h.api('customer.update', null, {}, 401)
  await update(first, { ...settings, paymentTermsDays: 40 }, owner, 400)
  await update(first, { ...settings, customFields: { 'Cost center': ['invalid'] } }, owner, 400)
  assert.equal(JSON.parse((await api(`customers/${first}`)).invoice_settings_json).poNumber, '')

  // Actually submit the form emitted by the customer screen, including the
  // parallel name/value controls; no implementation-only setup helper writes.
  const c = await api(`customers/${first}`)
  const saved = await h.submit('customer.update', finance, { customer: first, revision: c.revision, name: c.name,
    billing_email: c.billing_email, invoice_edit: 'yes', invoice_terms_days: '45', invoice_po_required: 'yes',
    invoice_po_number: 'BUYER-42', invoice_memo: settings.memo,
    invoice_field_name: ['Cost center', ''], invoice_field_value: ['Research West', ''] }, `/app/customers/${first}`)
  assert.equal(saved.searchParams.has('error'), false)
  await api('invoice.approve', { invoice: blocked.id, acknowledge: true }, 409)
  prepared = await prepare('2026-08')
  const invoice = prepared.invoices.find(i => i.customer_id === first)
  const other = prepared.invoices.find(i => i.customer_id === second)
  let detail = await api(`invoices/${invoice.id}`)
  const content = detail.calculation.inputs.invoiceContent
  assert.deepEqual([content.paymentTermsDays, content.poRequired, content.poNumber, content.memo, content.customFields], [45, true, 'BUYER-42', settings.memo, { 'Vendor ID': 'V-104', 'Cost center': 'Research West' }])
  const otherContent = (await api(`invoices/${other.id}`)).calculation.inputs.invoiceContent
  assert.equal(otherContent.paymentTermsDays, 30)
  assert.deepEqual(otherContent.customFields, { 'Vendor ID': 'V-104' }, 'INV-004 customer fields never leak to another customer')
  await api('invoice.approve', { invoice: invoice.id, acknowledge: true })
  await update(first, { ...settings, poNumber: 'BUYER-CHANGED' })
  await api('invoice.finalise', { invoice: invoice.id, issue_date: '2026-09-01' }, 409)
  await update(first, { ...settings, poNumber: 'BUYER-42' })
  prepared = await prepare('2026-08')
  const final = prepared.invoices.find(i => i.customer_id === first)
  await api('invoice.approve', { invoice: final.id, acknowledge: true })
  await api('invoice.finalise', { invoice: final.id, issue_date: '2026-09-01' })
  const finalOther=prepared.invoices.find(i=>i.customer_id===second)
  await api('invoice.approve',{invoice:finalOther.id,acknowledge:true})
  await api('invoice.finalise',{invoice:finalOther.id,issue_date:'2026-09-01'})
  detail = await api(`invoices/${final.id}`)
  assert.equal(detail.due_date, '2026-10-16', 'INV-004 Net45 means 45 calendar days after actual issue')
  assert.equal(detail.total_cents, 10000, 'INV-004 invoice content never changes rating cents')
  const originalCalculation = detail.calculation, originalFingerprint = detail.source_fingerprint
  await update(first, { paymentTermsDays: 15, poRequired: false, memo: 'Future invoices only', customFields: { 'Cost center': 'Changed' } })
  const changed = await api('business')
  await configure({ revision: changed.revision, invoice_fields: { 'Vendor ID': 'FUTURE-VENDOR' } })
  const after = await api(`invoices/${final.id}`)
  assert.deepEqual(after.calculation, originalCalculation, 'INV-004 issued content is immutable despite customer/business edits')
  assert.equal(after.source_fingerprint, originalFingerprint)
  assert.equal(after.due_date, '2026-10-16')
  const exported = await h.raw(`/app/billing/${prepared.run.id}.json`, { cookie: accountant })
  assert.equal(exported.status, 200)
  const document = (await exported.json()).invoices.find(i => i.id === final.id)
  assert.deepEqual(document.calculation.inputs.invoiceContent, originalCalculation.inputs.invoiceContent)
  assert.equal(document.dueDate, after.due_date)
  assert.deepEqual(document.lines.map(l => l.amount_cents), after.lines.map(l => l.amount_cents), 'INV-004 NEC-13 retains all original line detail')
  await onState?.({ label: 'issued', path: `/app/invoices/${final.id}`, owner, first })
  await onState?.({ label: 'customer-settings', path: `/app/customers/${first}`, owner, first })
  await onState?.({ label: 'business-fields', path: '/app/settings', owner, first })

  // Standalone invoices share the same required-PO and terms boundary.
  const manualCustomer = await create('MANUAL', settings)
  const charge = (await api('charge.add', { customer: manualCustomer, amount: '7', description: 'Standalone work', effective_date: '2026-08-01', taxable: false })).charge
  let manual = await api('invoice.manual', { customer: manualCustomer, charges: [charge], service_date: '2026-08-01' })
  assert.ok((await api(`invoices/${manual.id}`)).exceptions.some(e => e.code === 'po_required'))
  await api('invoice.approve', { invoice: manual.id, acknowledge: true }, 409)
  await update(manualCustomer, { ...settings, poNumber: 'MANUAL-PO' })
  manual = await api('invoice.manual', { customer: manualCustomer, charges: [charge], service_date: '2026-08-01' })
  await api('invoice.approve', { invoice: manual.id, acknowledge: true })
  await api('invoice.finalise', { invoice: manual.id, issue_date: '2026-08-01' })
  assert.equal((await api(`invoices/${manual.id}`)).due_date, '2026-09-15')

  // INV-004 / AGENT-006: quote, independent review, atomic installation and
  // complete-term preview/content/due-date parity with ordinary issue.
  const customerQuote = 'Cedar Order LLC, billing email order@invoice.example, customer INV004-ORDER.'
  const subscriptionQuote = 'Monthly arrears service from 2026-01-01 until 2026-03-01, on day 1.'
  const priceQuote = 'Invoice content service is USD 100 per month, non-taxable.'
  const invoiceQuote = 'Net 45; purchase order PO number ORDER-42 is required on every invoice. Memo: Buyer-approved service. Cost center: Order West.'
  const payload = { setup: true, source: { name: 'executed-order.txt', text: [customerQuote,subscriptionQuote,priceQuote,invoiceQuote].join('\n'), execution_reference: 'Buyer-recorded signed order 42' },
    customer: { external_id: 'INV004-ORDER', name: 'Cedar Order LLC', billing_email: 'order@invoice.example', quote: customerQuote },
    catalog: [{ key: 'base', existing: price, quote: priceQuote }],
    subscription: { start_date: '2026-01-01', months: 2, quote: subscriptionQuote },
    items: [{ key: 'base', price: 'base', quantity: 1, from: '2026-01-01', to: '2026-03-01', quote: priceQuote }],
    invoice: { paymentTermsDays: 45, poRequired: true, poNumber: 'ORDER-42', memo: 'Buyer-approved service.', customFields: { 'Cost center': 'Order West' }, quote: invoiceQuote } }
  const propose = (value, who = owner) => h.api('proposal.create', who, { kind: 'amendment', title: 'INV-004 quoted invoice requirements', payload: value })
  for (const invoice of [undefined, { ...payload.invoice, poNumber: '' }]) {
    const missing = structuredClone(payload)
    if (invoice) missing.invoice = invoice; else delete missing.invoice
    const pending = await propose(missing, agent)
    assert.ok(pending.impact.unresolvedAmbiguities.length, 'INV-004 / AGENT-006 missing invoice requirements cannot disappear at approval')
    await h.api('proposal.decide', finance, { proposal: pending.id, decision: 'approved' }, 409)
    assert.ok(!(await api('customers')).some(c => c.external_id === 'INV004-ORDER'))
    await h.api('proposal.decide', finance, { proposal: pending.id, decision: 'rejected' })
  }
  const proposed = await propose(payload)
  assert.deepEqual(proposed.impact.unresolvedAmbiguities, [])
  assert.deepEqual(proposed.impact.periods.map(p => [p.assumedIssueDate,p.dueDate,p.calculation.totalCents]), [['2026-02-01','2026-03-18',10000],['2026-03-01','2026-04-15',10000]])
  for (const key of ['paymentTermsDays','poRequired','poNumber','memo','customFields']) assert.ok(proposed.impact.quotes.some(q => q.field === `invoice.${key}` && q.quote === invoiceQuote))
  await onState?.({ label: 'quoted-order', path: `/app/proposals/${proposed.id}`, owner, first })
  await api('proposal.decide', { proposal: proposed.id, decision: 'approved' }, 409)
  const applied = await h.api('proposal.decide', finance, { proposal: proposed.id, decision: 'approved' })
  for (const preview of proposed.impact.periods) {
    const run = await prepare(preview.period.start.slice(0,7))
    const draft = run.invoices.find(i => i.customer_id === applied.customer)
    await api('invoice.approve', { invoice: draft.id, acknowledge: true })
    await api('invoice.finalise', { invoice: draft.id, issue_date: preview.assumedIssueDate })
    const issued = await api(`invoices/${draft.id}`)
    assert.equal(issued.due_date, preview.dueDate)
    assert.deepEqual(issued.calculation.inputs.invoiceContent, preview.invoiceContent)
    assert.equal(issued.total_cents, preview.calculation.totalCents)
  }
  await h.api('proposal.decide', finance, { proposal: proposed.id, decision: 'approved' }, 409)
  await invoicePresentation(h,owner,{first,second,invoice:final.id,otherInvoice:finalOther.id,branding,onState})
  console.log('Invoice terms, immutable branding, PDF, customer summary and quoted setup parity passed')
  return { customer: first, invoice: final.id }
}

async function invoicePresentation(h,owner,{first,second,invoice,otherInvoice,branding,onState}) {
  const api=(path,body,status)=>h.api(path,owner,body,status)
  await api('portal.configure',{hosts:[h.origin],parents:[]})
  const sessions=new Map(), sessionIds=new Map()
  for(const customer of [first,second]){const session=await api('portal.session.issue',{customer,origin:h.origin,audience:'hosted'});sessions.set(customer,session.token);sessionIds.set(customer,session.id)}
  const path=(id,customer=first,format='')=>`/portal/invoices/${id}?session=${encodeURIComponent(sessions.get(customer))}${format?`&format=${format}`:''}`
  const pdfText=buffer=>[...buffer.toString('latin1').matchAll(/<([0-9a-f]+)> Tj/g)].map(m=>Buffer.from(m[1],'hex').toString('latin1')).join('\n')
  const checkPdf=async(id,customer=first)=>{
    const response=await h.raw(path(id,customer,'pdf'))
    assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/pdf')
    assert.match(response.headers.get('content-disposition'),/^attachment;/)
    const bytes=Buffer.from(await response.arrayBuffer());assert.match(bytes.toString('latin1'),/^%PDF-1.4/)
    return {bytes,text:pdfText(bytes)}
  }
  const before=(await checkPdf(invoice)).text
  for(const text of ['BUYER-42','Net 45','V-104','Research West',branding.footer,branding.remitTo,'USD 100.00'])assert.ok(before.includes(text),`PDF contains ${text}`)
  const image=await h.raw(path(invoice,first,'logo'))
  assert.equal(image.status,200);assert.equal(Buffer.from(await image.arrayBuffer()).toString('base64'),branding.logo)
  const html=await h.page(path(invoice))
  for(const text of ['BUYER-42','V-104','Research West',branding.footer,branding.remitTo,'Download PDF'])assert.ok(html.includes(text),`Page contains ${text}`)
  await onState?.({label:'branded-customer-invoice',path:path(invoice),pdfPath:path(invoice,first,'pdf')})
  assert.equal((await h.raw(path(otherInvoice))).status,404,'another customer invoice is refused')
  assert.equal((await h.raw(path(otherInvoice,first,'pdf'))).status,404)
  assert.equal((await h.raw(`/portal/invoices/${invoice}?session=altered&format=pdf`)).status,401)
  assert.equal((await h.raw(`/portal/invoices/${invoice}?format=pdf`)).status,401)
  assert.equal((await h.raw(path(invoice),{method:'POST',body:{}})).status,405)
  const secondPdf=(await checkPdf(otherInvoice,second)).text
  assert.ok(secondPdf.includes('V-104'));assert.ok(!secondPdf.includes('Research West'),'PDF customer fields are isolated')
  const b=await api('business')
  await api('business.configure',{...b,invoice_branding:{color:'#331144',footer:'Future footer',remitTo:'Future treasury',logo:''}})
  assert.equal((await checkPdf(invoice)).text,before,'issued PDF retains original content after settings edits')
  const css=await h.raw(`/portal/theme.css?session=${encodeURIComponent(sessions.get(first))}&invoice=${invoice}`)
  assert.ok((await css.text()).includes('--accent:#245c46'),'page color uses the saved image')
  const payment=await api('payment.record',{customer:first,amount:'100',received_on:'2026-09-03',method:'bank_transfer',reference:'synthetic-nectar-invoice-payment',evidence:'Synthetic bank receipt'})
  await api('payment.allocate',{payment:payment.payment,invoice,amount:'100'})
  assert.match((await checkPdf(invoice)).text,/Balance owed: USD 0.00/)
  await onState?.({label:'paid-customer-invoice',path:path(invoice),pdfPath:path(invoice,first,'pdf')})

  // Real tiered usage remains in operator evidence, but each customer summary
  // contains a single metered-price total across current and late service lines.
  const hidden=(await api('customer.create',{external_id:'INV004-HIDDEN',name:'Cedar summary customer',billing_email:'summary@example.test',language:'es-US',invoice_settings:{hideUsageDetail:true}})).id
  const meter=(await api('meter.create',{code:'inv004-calls',name:'Calls',unit_label:'calls'})).id
  const product=(await api('product.create',{code:'inv004-usage',name:'API usage'})).id
  const price=(await api('price.create',{product,meter,kind:'unit',taxable:false,pricing_model:'graduated',tiers:[{up_to:'100',unit_amount:'1'},{up_to:null,unit_amount:'0.50'}]})).id
  const visible=(await api('customer.create',{external_id:'INV004-DETAIL',name:'Cedar detailed customer',billing_email:'detail@example.test'})).id
  for(const customer of [hidden,visible])await api('subscription.create',{customer,start_date:'2026-06-01',price:[price]})
  const report=await api('usage.submit',{events:['HIDDEN','DETAIL'].flatMap(customer=>[['2026-07-14T12:00:00Z','150'],['2026-08-14T12:00:00Z','150']].map(([occurred_at,quantity],index)=>({event_id:customer==='HIDDEN'?`synthetic-nectar-invoice-${index+1}`:`synthetic-nectar-invoice-detail-${index+1}`,occurred_at,quantity,meter:'inv004-calls',customer:`INV004-${customer}`})))})
  assert.equal(report.accepted,4)
  const run=await api('billrun.prepare',{period:'2026-08'}),draft=(await api(`runs/${run.id}`)).invoices.find(i=>i.customer_id===hidden)
  await api('invoice.approve',{invoice:draft.id,acknowledge:true});await api('invoice.finalise',{invoice:draft.id,issue_date:'2026-09-01'})
  const detailed=(await api(`runs/${run.id}`)).invoices.find(i=>i.customer_id===visible)
  await api('invoice.approve',{invoice:detailed.id,acknowledge:true});await api('invoice.finalise',{invoice:detailed.id,issue_date:'2026-09-01'})
  sessions.set(visible,(await api('portal.session.issue',{customer:visible,origin:h.origin,audience:'hosted'})).token)
  const detailedHtml=await h.page(path(detailed.id,visible)),detailedPdf=await checkPdf(detailed.id,visible)
  for(const text of ['Quantity: 150.00','Tier 1:','Tier 2:','USD 250.00']){assert.ok(detailedHtml.includes(text),text);assert.ok(detailedPdf.text.includes(text),text)}
  assert.doesNotMatch(detailedHtml,/synthetic-nectar-invoice-detail/)
  await onState?.({label:'detailed-customer-invoice',path:path(detailed.id,visible),pdfPath:path(detailed.id,visible,'pdf')})
  const operator=await api(`invoices/${draft.id}`)
  assert.equal(operator.total_cents,25000);assert.ok(operator.lines.length>=2)
  assert.ok(operator.lines.some(line=>line.evidence.tiers?.length),'operator retains tier breakdown')
  const exported=await h.raw(`/app/billing/${run.id}.json`,{cookie:owner}),document=(await exported.json()).invoices.find(i=>i.id===draft.id)
  assert.deepEqual(document.lines.map(l=>l.amount_cents),operator.lines.map(l=>l.amount_cents))
  assert.ok(JSON.stringify(document).includes('synthetic-nectar-invoice-1'))
  sessions.set(hidden,(await api('portal.session.issue',{customer:hidden,origin:h.origin,audience:'hosted'})).token)
  const token=sessions.get(hidden)
  const data=await (await h.raw(`/portal/data?session=${encodeURIComponent(token)}`)).json()
  assert.equal(data.invoices.find(i=>i.id===draft.id).total_cents,25000)
  const page=await h.page(path(draft.id,hidden))
  // Opaque transport identifiers can randomly contain "150". Keep the full
  // content fence, excluding only this request's exact invoice ID and token.
  const invoiceContent=page.replaceAll(draft.id,'[invoice-id]').replaceAll(encodeURIComponent(token),'[session-token]')
  assert.match(page,/Descargar PDF/);assert.doesNotMatch(invoiceContent,/synthetic-nectar-invoice-|150|tier|breakdown|quantity/)
  const pdf=await checkPdf(draft.id,hidden)
  assert.match(pdf.text,/USD 250.00/);assert.doesNotMatch(pdf.text,/synthetic-nectar-invoice-|150|tier|breakdown/)
  assert.equal((pdf.text.match(/API usage/g)??[]).length,1,'one summary line per metered price')
  assert.equal((await h.raw(`/portal/evidence/invoices/${draft.id}?session=${encodeURIComponent(token)}`)).status,403)
  assert.equal((await h.raw(`/portal/evidence/invoices/${draft.id}/lines/${operator.lines[0].id}?session=${encodeURIComponent(token)}`)).status,403)
  await onState?.({label:'hidden-usage-spanish',path:path(draft.id,hidden),pdfPath:path(draft.id,hidden,'pdf')})
  await onState?.({label:'operator-usage-detail',path:`/app/invoices/${draft.id}`,owner})
  const c=await api(`customers/${hidden}`)
  await api('customer.update',{customer:hidden,revision:c.revision,name:c.name,billing_email:c.billing_email,language:'en'})
  const english=await checkPdf(draft.id,hidden)
  assert.match(english.text,/USD 250.00/);assert.match(await h.page(path(draft.id,hidden)),/Download PDF/)
  await onState?.({label:'hidden-usage-english',path:path(draft.id,hidden),pdfPath:path(draft.id,hidden,'pdf')})
  await api('portal.session.revoke',{session:sessionIds.get(first)})
  assert.equal((await h.raw(path(invoice,first,'pdf'))).status,401,'revocation withdraws the PDF too')
}

export async function invoiceAutomationFlow(h,owner,{onState}={}) {
  const api=(path,body,status)=>h.api(path,owner,body,status)
  await h.advanceClock('2026-08-31T12:00:00Z')
  const tick=async instant=>{
    await h.advanceClock(instant)
    const response=await h.raw(`/cdn-cgi/local/scheduled?time=${Date.parse(instant)}&cron=${encodeURIComponent('* * * * *')}`)
    assert.equal(response.status,200)
  }
  const create=async(external_id,invoice_settings={})=>(await api('customer.create',{external_id,name:external_id,billing_email:`${external_id.toLowerCase()}@example.test`,invoice_settings})).id
  const clean=await create('INV001-CLEAN'),exception=await create('INV001-EXCEPTION',{poRequired:true}),advance=await create('INV001-ADVANCE')
  const product=(await api('product.create',{code:'inv001-scheduled',name:'Scheduled service'})).id
  const price=(await api('price.create',{product,kind:'flat',unit_amount:'100',taxable:false})).id
  const advanceProduct=(await api('product.create',{code:'inv001-advance',name:'Advance service'})).id
  const advancePrice=(await api('price.create',{product:advanceProduct,kind:'flat',unit_amount:'150',taxable:false,interval_unit:'month',interval_count:1,billing_timing:'advance'})).id
  for(const customer of [clean,exception])await api('subscription.create',{customer,start_date:'2026-08-01',price:[price]})
  await api('subscription.create',{customer:advance,start_date:'2026-09-01',billing_anchor_date:'2026-09-01',price:[advancePrice]})
  const invoices=async()=> (await api('invoices')).data
  await tick('2026-09-01T12:00:00Z')
  assert.equal((await invoices()).length,0,'default-off schedules issue nothing')
  const rejected=await api('invoice.automation.prepare',{enabled:true,hour:5})
  await api('invoice.automation.decide',{request:rejected.request,decision:'rejected'})
  await tick('2026-09-01T12:01:00Z')
  assert.equal((await invoices()).length,0,'rejected consent never enables automation')
  const stale=await api('invoice.automation.prepare',{enabled:true,hour:5})
  const pending=await api('invoice.automation.prepare',{enabled:true,hour:6})
  await onState?.({label:'automatic-policy-pending',path:'/app/billing',owner})
  await api('invoice.automation.decide',{request:pending.request,decision:'approved'},409)
  await api('invoice.automation.decide',{request:pending.request,decision:'approved',confirm_single:true})
  await api('invoice.automation.decide',{request:pending.request,decision:'approved',confirm_single:true},409)
  await api('invoice.automation.decide',{request:stale.request,decision:'approved',confirm_single:true},409)
  await api('invoice.automation.decide',{request:stale.request,decision:'rejected'})
  await onState?.({label:'automatic-policy-enabled',path:'/app/billing',owner})
  await tick('2026-09-01T12:59:00Z')
  assert.equal((await invoices()).length,0,'business-local hour controls the schedule')
  await tick('2026-09-01T13:00:00Z')
  const issued=await invoices()
  assert.deepEqual(issued.map(i=>i.customer_id).sort(),[clean,advance].sort())
  const first=issued.find(i=>i.customer_id===clean),upfront=issued.find(i=>i.customer_id===advance)
  assert.equal(first.total_cents,10000);assert.equal(upfront.total_cents,15000)
  assert.equal(upfront.period_start,'2026-09-01');assert.equal(upfront.period_end,'2026-10-01')
  const runs=await api('runs'),august=runs.find(r=>r.period==='2026-08'),drafts=(await api(`runs/${august.id}`)).invoices
  const held=drafts.find(i=>i.customer_id===exception)
  assert.equal(held.status,'draft');assert.ok(held.exceptions.some(e=>e.code==='po_required'))
  await api('invoice.approve',{invoice:held.id,acknowledge:true},409)
  await onState?.({label:'automatic-run-review',path:`/app/billing/${august.id}`,owner})
  const source=(await api(`invoices/${first.id}`)).source_fingerprint
  await h.advanceClock('2026-09-01T13:01:00Z')
  const repeated=`/cdn-cgi/local/scheduled?time=${Date.parse('2026-09-01T13:01:00Z')}&cron=${encodeURIComponent('* * * * *')}`
  const duplicateTicks=await Promise.all([h.raw(repeated),h.raw(repeated)])
  for(const response of duplicateTicks)assert.equal(response.status,200)
  assert.equal((await invoices()).length,2,'duplicate and overlapping cron ticks never issue twice')
  assert.equal((await api(`invoices/${first.id}`)).source_fingerprint,source)
  assert.equal((await api('native-collections')).length,0,'invoice issue grants no charge authority')
  assert.ok(!h.mails.some(m=>m.to.includes('inv001-clean@example.test')),'invoice issue sends no invoice email')
  const audit=await api('audit')
  assert.ok(audit.some(r=>r.action==='invoice.automation.complete'))
  assert.ok(audit.filter(r=>r.action==='invoice.issue').every(r=>r.actor.startsWith('system:invoice-automation:')))
  await api('access.give',{email:'inv001-finance@example.test',name:'Finance',role:'finance'})
  const finance=await h.signIn('inv001-finance@example.test',{requested:true})
  const agent={bearer:(await api('credential.issue',{name:'Scheduling preparer',scopes:['prepare']})).key}
  for(const action of ['invoice.automation.prepare','invoice.automation.decide','invoice.automation.run']){
    await h.api(action,agent,{},403);await h.api(action,null,{},401)
  }
  await h.api('invoice.automation.prepare',finance,{enabled:false,hour:6},403)
  const disable=await api('invoice.automation.prepare',{enabled:false,hour:6})
  await api('invoice.automation.decide',{request:disable.request,decision:'approved',confirm_single:true},409)
  await h.api('invoice.automation.decide',finance,{request:disable.request,decision:'approved'})
  await tick('2026-10-01T13:00:00Z')
  assert.equal((await invoices()).length,2,'disabled policy stops further automatic issue')
  await onState?.({label:'automatic-policy-disabled',path:'/app/billing',owner})
  // The next scheduler tick rechecks the policy maker as an active owner.
  const enable=await api('invoice.automation.prepare',{enabled:true,hour:6})
  await h.api('invoice.automation.decide',finance,{request:enable.request,decision:'approved'})
  const members=await api('members')
  await api('access.end',{member:members.find(m=>m.email==='inv001-finance@example.test').id})
  await tick('2026-10-01T13:01:00Z')
  assert.equal((await invoices()).length,2,'removed approval authority stops scheduled issue')
  console.log('Automatic invoice policy, independent consent, local schedule, clean issue, held exceptions, advance periods and duplicate safety passed')
}
