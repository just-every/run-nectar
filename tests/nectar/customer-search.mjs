import { portalMethodActionsEdge, assertPortalMethodActions } from './portal-method-actions.mjs'
import { assertCustomerFullCycle } from './customer-cycle.mjs'
import { assertPaymentReceipts } from './payment-receipts.mjs'
import { achPaymentEvidenceEdge,assertAchPaymentEvidence } from './ach-payment-evidence.mjs'
import { customerPaymentMethodsEdge,assertCustomerPaymentMethods,hostedSetupEdge,assertHostedSetups } from './customer-payment-methods.mjs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { file } from './harness.mjs'
import { prepaidRefundEdge } from './prepaid-refunds.mjs'
import { totp } from './mfa.mjs'

let edge,methodEdge,achEdge,setupEdge
export const harnessOptions = () => {
  edge = prepaidRefundEdge()
  methodEdge=customerPaymentMethodsEdge(edge.fetch)
  achEdge=achPaymentEvidenceEdge(methodEdge.fetch)
  setupEdge=portalMethodActionsEdge(hostedSetupEdge(achEdge.fetch))
  return { stripeFetch: setupEdge.fetch, stripeSecret: 'synthetic-nectar-1', stripeSecondarySecret: 'synthetic-nectar-2' }
}

// CUS-001 current-source composition; the full clause remains partial.
export async function customerSearchFlow(h, owner, onReady = async () => {},interaction={}) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  const create = async (external_id, name, billing_email) => (await api('customer.create', { external_id, name, billing_email })).id
  const customer = await create('MARIGOLD-OPS', 'Marigold Research', 'billing@marigold.example')
  const other = await create('CEDAR-OPS', 'Cedar Fieldwork', 'billing@cedar.example')
  await api('contact.add', { customer, name: 'Priya Billing', email: 'priya@marigold.example' })
  const charge = await api('charge.add', { customer, amount: '125', description: 'Research workshop', effective_date: '2026-01-05', taxable: false })
  const draft = await api('invoice.manual', { customer, charges: [charge.charge], service_date: '2026-01-05' })
  await api('invoice.approve', { invoice: draft.id, acknowledge: true })
  await api('invoice.finalise', { invoice: draft.id, issue_date: '2026-01-05' })
  const invoice = await api(`invoices/${draft.id}`)
  const credit = await api('credit.issue', { invoice: draft.id, amount: '25', reason: 'Workshop service adjustment' })
  const payment = await api('payment.record', { customer, amount: '75', method: 'bank_transfer', reference: 'BANK_MARIGOLD%7781', received_on: '2026-01-07' })
  await api('payment.allocate', { payment: payment.payment, invoice: draft.id, amount: '75' })
  await api('payment.record', { customer: other, amount: '20', method: 'card_external', reference: 'OTHER-CARD-7781', received_on: '2026-01-08' })
  await api('note.add', { kind: 'customer', record: customer, body: 'Finance confirmed the workshop adjustment.' })
  await api('metadata.write', { kind: 'customer', record: customer, revision: 0, metadata: { segment: 'Enterprise research' } })

  const queries = ['billing@marigold.example', '  MARIGOLD  ', 'MARIGOLD-OPS', 'PRIYA@MARIGOLD.EXAMPLE', invoice.number, credit.number, 'bank_marigold%7781', 'Enterprise research']
  for (const query of queries) assert.deepEqual((await api(`customers?search=${encodeURIComponent(query)}`)).map(row => row.id), [customer], `CUS-001 resolves ${query} to its customer only`)
  for (const query of ["' OR 1=1 --", '%', '_']) {
    const matches = await api(`customers?search=${encodeURIComponent(query)}`)
    assert.deepEqual(matches.map(row => row.id), query === "' OR 1=1 --" ? [] : [customer], 'CUS-001 search text is literal, including wildcard characters')
  }
  assert.deepEqual(await api('customers?search=no-such-billing-record'), [])
  assert.deepEqual((await api('customers?search=OTHER-CARD-7781')).map(row => row.id), [other])
  assert.deepEqual((await api(`customers?search=marigold&metadata_key=segment&metadata_value=${encodeURIComponent('Enterprise research')}`)).map(row => row.id), [customer])
  assert.deepEqual(await api('customers?search=marigold&metadata_key=segment&metadata_value=unrelated'), [])

  const record = await api(`customers/${customer}`), ledger = record.ledger
  assert.deepEqual([ledger.invoicedCents, ledger.creditedCents, ledger.paidCents, ledger.balanceCents], [12500, 2500, 7500, 2500])
  assert.equal(ledger.invoicedCents, ledger.creditedCents + ledger.paidCents + ledger.balanceCents)
  assert.deepEqual(ledger.payments.map(row => row.id), [payment.payment])
  assert.deepEqual(ledger.credits.map(row => row.number), [credit.number])
  assert.equal(record.billingRecord.creditBalance.totalCents, 0)
  assert.deepEqual(record.billingRecord.refunds, [])
  assert.deepEqual(record.billingRecord.prepaid, [])
  const customerEvents = record.billingRecord.auditEvents
  assert.ok(customerEvents.some(event => event.action === 'customer.create' && event.subject === customer))
  assert.ok(customerEvents.some(event => event.action === 'payment.record' && event.subject === payment.payment))
  assert.ok(customerEvents.some(event => event.action === 'credit.issue' && event.subject === credit.credit))
  assert.ok(customerEvents.every(event => Object.keys(event).sort().join(',') === 'action,at,seq,subject'), 'Customer audit never exposes free-text detail or narrative actor labels')
  assert.ok(!(await api(`customers/${other}`)).billingRecord.auditEvents.some(event => customerEvents.some(own => own.seq === event.seq)), 'Audit subjects belong only to their customer')
  for (const role of ['support', 'accountant', 'collections']) {
    const email = `lookup-${role}@example.test`
    await api('access.give', { email, name: `Lookup ${role}`, role })
    const cookie = await h.signIn(email, { requested: true })
    assert.deepEqual((await h.api(`customers?search=${encodeURIComponent(credit.number)}`, cookie)).map(row => row.id), [customer])
    const scopedRecord = await h.api(`customers/${customer}`, cookie)
    assert.deepEqual(scopedRecord.ledger, ledger)
    assert.deepEqual(scopedRecord.billingRecord.creditBalance, record.billingRecord.creditBalance)
    assert.deepEqual(scopedRecord.billingRecord.refunds, [])
    assert.ok(!JSON.stringify(scopedRecord.billingRecord).includes('Finance confirmed the workshop adjustment.'))
    const html = await h.page(`/app/customers/${customer}`, cookie)
    assert.ok(html.includes(credit.number) && html.includes('Workshop service adjustment'), 'CUS-001 credit evidence appears on the customer screen')
    await h.api('customer.update', cookie, { customer, revision: record.revision, name: 'Forbidden', billing_email: record.billing_email }, 403)
  }
  await h.api('customers?search=marigold', undefined, undefined, 401)
  await h.api(`customers/${customer}`, undefined, undefined, 401)
  const history = []
  for (let index = 0; index < 210; index++) history.push((await api('payment.record', { customer: other, amount: '1', method: 'check', reference: `CEDAR-ARCHIVE-${index}`, received_on: '2025-01-07' })).payment)
  const complete = (await api(`customers/${other}`)).ledger
  for (const id of history) assert.ok(complete.payments.some(row => row.id === id), 'CUS-001 customer ledger retains older payments as its history grows')
  assert.equal(complete.unallocatedCents, 23000, 'CUS-001 all retained payment amounts contribute to the unallocated total')
  assert.equal((await api(`customers/${other}`)).billingRecord.creditBalance.cashCents, 23000)
  const archiveEvents = (await api(`customers/${other}`)).billingRecord.auditEvents
  for (const id of history) assert.ok(archiveEvents.some(event => event.action === 'payment.record' && event.subject === id), 'Customer audit retains history outside the global latest-500 window')
  const audit = await api('audit')
  for (const path of ['/app/customers', `/app/customers/${customer}`, '/app/receivables', '/app/billing']) {
    const html = await h.page(path, owner)
    assert.match(html, /role="search"[^>]*aria-label="Customer lookup"/, 'CUS-001 the shared operator frame offers the lookup door')
  }
  assert.deepEqual(await api('audit'), audit, 'CUS-001 lookup and record reads do not mutate billing')
  await onReady({ h, owner, customer, other, invoice, credit, ledger })

  // Verified processor source through the real native collection API; only
  // Stripe's network boundary is synthetic.
  await assertPaymentReceipts(h,owner)
  const instant = Date.parse('2026-10-22T10:00:00Z')
  await h.advanceClock(new Date(instant).toISOString())
  const factor = await api('mfa.totp.start', {})
  await api('mfa.totp.confirm', { factor: factor.factor, code: totp(factor.secret, instant) })
  const nativeCustomer = await create('synthetic-nectar-1', 'Cedar Observatory', 'synthetic-nectar-3@example.test')
  const nativeCharge = await api('charge.add', { customer: nativeCustomer, amount: '10', description: 'synthetic-nectar-3', effective_date: '2026-10-20', taxable: false })
  const nativeInvoice = await api('invoice.manual', { customer: nativeCustomer, charges: [nativeCharge.charge], service_date: '2026-10-20' })
  await api('invoice.approve', { invoice: nativeInvoice.id, acknowledge: true })
  await api('invoice.finalise', { invoice: nativeInvoice.id, issue_date: '2026-10-20' })
  const nativeBinding=await api('collection.customer.bind', { customer: nativeCustomer, account_ref: 'synthetic-nectar-native-account-1', stripe_customer_ref: 'synthetic-nectar-native-customer-1', confirm: true })
  const review = await api('collection.prepare', { invoice: nativeInvoice.id })
  const collected = await api('collection.confirm', review.instructions.confirm)
  assert.equal(collected.status, 'collected')
  await api('access.give',{email:'synthetic-nectar-114@example.test',name:'Synthetic customer finance',role:'finance'})
  const finance=await h.signIn('synthetic-nectar-114@example.test',{requested:true})
  await assertCustomerPaymentMethods(h,owner,{customer:nativeCustomer,other,finance,edge:methodEdge,refresh:interaction.refreshMethods})
  const achCharge=await api('charge.add',{customer:nativeCustomer,amount:'7.25',description:'Settled bank payment workshop',effective_date:'2026-10-20',taxable:false})
  const achInvoice=await api('invoice.manual',{customer:nativeCustomer,charges:[achCharge.charge],service_date:'2026-10-20'})
  await api('invoice.approve',{invoice:achInvoice.id,acknowledge:true})
  await api('invoice.finalise',{invoice:achInvoice.id,issue_date:'2026-10-20'})
  const ach=await assertAchPaymentEvidence(h,owner,{customer:nativeCustomer,invoice:achInvoice.id,edge:achEdge,finance,other,record:interaction.recordAch})
  for(const query of [ach.paymentIntentRef,ach.chargeRef])assert.deepEqual((await api(`customers?search=${encodeURIComponent(query)}`)).map(row=>row.id),[nativeCustomer])
  await onReady({h,owner,customer:nativeCustomer,query:ach.chargeRef,kind:'ach'})
  await assertCustomerFullCycle(h,owner,{customer:nativeCustomer,finance,edge,onReady})
  const support=await h.signIn('lookup-support@example.test')
  assert.equal((await h.api(`customers/${nativeCustomer}`,support)).billingRecord.savedPaymentMethods[0].methods.length,3)
  assert.equal((await h.api(`customers/${nativeCustomer}`,support)).billingRecord.achPaymentEvidence[0].id,ach.id)
  await h.api('customer.payment_methods.refresh',support,{customer:nativeCustomer},403)
  for(const query of ['1111','visa 1111'])assert.deepEqual((await api(`customers?search=${encodeURIComponent(query)}`)).map(row=>row.id),[nativeCustomer])
  const unified=(await api(`customers/${nativeCustomer}`)).billingRecord
  for(const receipt of unified.receipts){assert.deepEqual(await api(`payments/${receipt.payment}/receipt`),receipt);assert.deepEqual((await api(`customers?search=${receipt.number}`)).map(row=>row.id),[nativeCustomer])}
  const processorRecord = (await api(`customers/${nativeCustomer}`)).billingRecord
  assert.ok(processorRecord.paymentMethods.length>=2)
  for(const method of processorRecord.paymentMethods)assert.deepEqual(method.card,{ brand: 'visa', last4: '4242', expMonth: 12, expYear: 2035 })
  assert.equal(processorRecord.processorPayments[0].captured, true)
  for (const query of [collected.payment_intent_ref, collected.charge_ref, '4242', 'visa 4242', '4242 VISA']) {
    assert.deepEqual((await api(`customers?search=${encodeURIComponent(query)}`)).map(row => row.id), [nativeCustomer])
  }
  assert.deepEqual(await api('customers?search=mastercard%204242'), [], 'A wrong brand is never rescued by matching last four')
  for (const field of ['basis_json', 'proof_json', 'proof', 'review', 'instructions']) assert.ok(!(field in processorRecord.processorPayments[0]), 'Customer projection excludes processor internals')
  const nativePage=await h.page(`/app/customers/${nativeCustomer}`,owner);assert.ok(nativePage.includes(collected.charge_ref));assert.ok(nativePage.includes('4242'))
  await onReady({h,owner,customer:nativeCustomer,query:collected.charge_ref,kind:'processor'})
  const role = await api('role.define', { name: 'synthetic-nectar-4', capabilities: ['read.customers'] })
  await api('access.give', { email: 'synthetic-nectar-4@example.test', name: 'synthetic-nectar-4', role: 'custom', custom_role: role.id })
  const customerReader = await h.signIn('synthetic-nectar-4@example.test', { requested: true })
  const customerOnly=await h.api(`customers/${nativeCustomer}`,customerReader)
  const restricted=customerOnly.billingRecord
  for (const family of ['processorPayments', 'paymentMethods', 'refunds', 'prepaid', 'creditBalance','subscriptionHistory','writeOffs','savedPaymentMethods','achPaymentEvidence','receipts','paymentLinks','automaticCollections','hostedSetups','cardLifecycle','cardExpiryNotices']) assert.equal(restricted[family], null, 'Family-scoped customer readers receive no new financial source')
  const customerSubjects=new Set([nativeCustomer,...customerOnly.contacts.map(row=>row.id),...customerOnly.notes.filter(row=>row.kind==='customer').map(row=>row.id)])
  assert.ok(restricted.auditEvents.every(event => customerSubjects.has(event.subject)), 'Audit respects customer, contact and customer-note family scope')
  assert.deepEqual(await h.api(`customers?search=${collected.charge_ref}`, customerReader), [])
  const snapshot = await api('audit')
  for (const query of [collected.charge_ref, 'visa 4242']) await api(`customers?search=${encodeURIComponent(query)}`)
  await api(`customers/${nativeCustomer}`)
  assert.deepEqual(await api('audit'), snapshot, 'Processor search and customer composition remain read-only')

  // Captured previous-biller documents also resolve to their own customer.
  const files = Object.fromEntries(await Promise.all(['manifest', 'customers', 'products', 'prices', 'subscriptions', 'invoices', 'meters'].map(async name => [name, file(`${name}.json`, await readFile(new URL(`../fixtures/stripe/${name}.json`, import.meta.url)), 'application/json')])))
  const preview = await api('import.preview', files)
  await api('import.apply', { ...files, fingerprint: preview.fingerprint })
  const captured = JSON.parse(await readFile(new URL('../fixtures/stripe/invoices.json', import.meta.url))).data[0]
  const moved = (await api('customers')).find(row => row.external_id === captured.customer)
  for (const value of [captured.number, captured.id]) assert.deepEqual((await api(`customers?search=${encodeURIComponent(value)}`)).map(row => row.id), [moved.id], 'CUS-001 retained previous-biller number and reference resolve to the moved customer')
  const shadow = (await api(`customers/${moved.id}?preview_period=2026-08`)).upcoming
  assert.ok(shadow.length > 0 && shadow.every(row => row.state === 'shadow'), 'CUS-001 imported subscriptions stay explicitly shadow calculations')
  const adopted = (await api('shadow')).find(row => row.id === shadow[0].subscription)
  await api('subscription.adopt', { subscription: adopted.id, cutover_start: adopted.earliestCutover, acknowledge_unreconciled: true })
  const retained = (await api(`customers/${moved.id}?preview_period=2026-08`)).upcoming.find(row => row.subscription === adopted.id)
  assert.equal(retained.reason, 'previous_biller_period')
  assert.equal(retained.totalCents, null, 'CUS-001 a period owned by the previous biller is not quoted as a Nectar charge')
  assert.match(await h.page(`/app/customers/${moved.id}?preview_period=2026-08`, owner), /Previous biller owns this period/)
  await assertHostedSetups(h,owner,{customer:nativeCustomer,other,binding:nativeBinding.id,finance,edge:setupEdge,onState:interaction.hostedState,executeStart:interaction.startHosted,executeFinish:interaction.finishHosted,executePrepare:interaction.prepareHosted})
  await assertPortalMethodActions(h,owner,{customer:nativeCustomer,other,binding:nativeBinding.id,finance,edge:setupEdge,onState:interaction.methodState,executePrepare:interaction.prepareMethodAction,executeAction:interaction.confirmMethodAction,executeUncertainAction:interaction.confirmUncertainMethodAction})
  const erasure = await api('erasure.request', { customer: nativeCustomer })
  await api('erasure.verify', { request: erasure.id, reason: 'synthetic-nectar-5', evidence: file('synthetic-nectar-5.txt', 'synthetic-nectar-5', 'text/plain') })
  const erasedApproval=await api('erasure.approve', { request: erasure.id, confirm: true })
  const erased = await api(`customers/${nativeCustomer}`)
  assert.ok(!erased.billingRecord || Object.entries(erased.billingRecord).every(([key, value]) => key === 'auditEvents' ? value.length === 0 : value === null), 'Erased customer composition never parses retained private sources')
  for (const query of [collected.charge_ref, collected.payment_intent_ref,ach.chargeRef,ach.paymentIntentRef, 'visa 4242']) assert.deepEqual(await api(`customers?search=${encodeURIComponent(query)}`), [], 'Retained processor identity is not searchable after erasure')
  // Minimal financial custody keeps the once-only attribution even after its
  // private provider labels are erased and provider metadata later changes.
  const replacement=await create('synthetic-nectar-306','Synthetic replacement customer','synthetic-nectar-306@example.test')
  const replacementCharge=await api('charge.add',{customer:replacement,amount:'7.25',description:'Synthetic replacement service',effective_date:'2026-10-22',taxable:false})
  const replacementInvoice=await api('invoice.manual',{customer:replacement,charges:[replacementCharge.charge],service_date:'2026-10-22'})
  await api('invoice.approve',{invoice:replacementInvoice.id,acknowledge:true})
  await api('invoice.finalise',{invoice:replacementInvoice.id,issue_date:'2026-10-22'})
  await api('collection.customer.bind',{customer:replacement,account_ref:'synthetic-nectar-native-account-1',stripe_customer_ref:'synthetic-nectar-native-customer-1',confirm:true})
  achEdge.configureCaptured({invoice:replacementInvoice.id,amountCents:725,currency:'USD',date:'2026-10-22T00:00:00Z'})
  await api('payment.ach_evidence.record',{invoice:replacementInvoice.id,account_ref:'synthetic-nectar-native-account-1',payment_intent_ref:ach.paymentIntentRef,confirm:true},409)
  assert.deepEqual((await api(`customers/${replacement}`)).ledger.payments,[],'Erasure cannot free the same settled cash for another customer')
  await h.advanceClock(`${erasedApproval.receipt.retained.until}T16:00:00Z`)
  assert.ok((await api('erasure.purge',{})).removed.includes(erasure.id),'Receipt and ACH financial facts follow the owner-approved removal boundary')
  for(const receipt of processorRecord.receipts)await api(`payments/${receipt.payment}/receipt`,undefined,404)
  const laterPayment=await api('payment.record',{customer:replacement,amount:'0.01',received_on:erasedApproval.receipt.retained.until,method:'bank_transfer',reference:'synthetic-nectar-307'})
  const laterReceipt=await api(`payments/${laterPayment.payment}/receipt`)
  assert.ok(laterReceipt.sequence>Math.max(...processorRecord.receipts.map(row=>row.sequence)),'Financial removal never recycles an old customer receipt number')
  for(const receipt of processorRecord.receipts)assert.deepEqual(await api(`customers?search=${receipt.number}`),[],'A removed customer receipt never resolves to another customer')
  // Customer capture cannot outlive the current authority that prepared it.
  await api('mfa.verify',{code:totp(factor.secret,Date.parse(h.vars.NECTAR_LOCAL_TIME))})
  const revokedSource=await create('synthetic-nectar-821','Synthetic setup authority','synthetic-nectar-821@example.test')
  const revokeBinding=await api('collection.customer.bind',{customer:revokedSource,account_ref:'synthetic-nectar-native-account-1',stripe_customer_ref:'synthetic-nectar-native-customer-4',confirm:true})
  const revokedSetup=await api('checkout.setup.prepare',{customer:revokedSource,binding:revokeBinding.id,method:'card',confirm:true})
  const scopedSession=await api('portal.session.issue',{customer:revokedSource,origin:h.origin,audience:'hosted'})
  const scopedPage=await h.page(`/portal/payment-methods?session=${encodeURIComponent(scopedSession.token)}`)
  const consentHash=scopedPage.match(/name="consent_hash" value="([^"]+)"/)[1]
  const createsBefore=setupEdge.calls.filter(call=>call.operation==='create').length
  assert.equal((await h.raw('/auth/signout',{cookie:owner,body:{}})).status,204)
  const refusedSource=await h.raw(`/portal/payment-methods/start?session=${encodeURIComponent(scopedSession.token)}`,{body:{setup:revokedSetup.id,confirm:true,consent_hash:consentHash,make_default:true}})
  assert.equal(refusedSource.status,409,'A signed-out preparing owner cannot authorize a later customer claim')
  assert.equal(setupEdge.calls.filter(call=>call.operation==='create').length,createsBefore,'A revoked source causes no provider write')
  console.log('CUS-001 customer lookup, literal searches, scoped billing evidence, totals and role custody passed')
  return { customer, other, invoice, credit }
}
