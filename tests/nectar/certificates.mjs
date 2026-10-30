import { applyPolicy } from './policy-helper.mjs'
import assert from 'node:assert/strict'
import { file } from './harness.mjs'

export async function exemptionCertificates(h, owner) {
  const before = await h.api('business', owner)
  const policy = async state => {
    await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: state, tax_mode: 'flat_rate', tax_rate: '10', tax_note: 'Reviewed declared test rate for certificate journey' })
    await h.api('tax.review', owner, { revision: (await h.api('business', owner)).revision })
  }
  const customer = (await h.api('customer.create', owner, { external_id: 'CERT-TEXAS', name: 'Lone Star Laboratory', billing_email: 'ap@lonestar.example' })).id
  const product = (await h.api('product.create', owner, { code: 'cert-service', name: 'Laboratory platform' })).id
  const price = (await h.api('price.create', owner, { product, kind: 'flat', unit_amount: '100', taxable: true })).id
  const sub = (await h.api('subscription.create', owner, { customer, start_date: '2026-06-01', price: [price] })).id
  const invoice = async month => {
    const run = await h.api('billrun.prepare', owner, { period: month })
    const draft = (await h.api(`runs/${run.id}`, owner)).invoices.find(i => i.customer_id === customer)
    assert.ok(draft)
    return await h.api(`invoices/${draft.id}`, owner)
  }
  const issue = async draft => {
    await h.api('invoice.approve', owner, { invoice: draft.id, acknowledge: true })
    await h.api('invoice.finalise', owner, { invoice: draft.id, issue_date: draft.period_end })
    return await h.api(`invoices/${draft.id}`, owner)
  }
  // An expressly requested exemption without a document cannot be issued.
  await policy('TX')
  await h.api('exemption.claim', owner, { customer, state: 'TX' })
  let missing = await invoice('2026-06')
  assert.ok(missing.exceptions.some(x => x.code === 'exemption_certificate'))
  await h.api('invoice.approve', owner, { invoice: missing.id, acknowledge: true }, 409)
  const pdf = '%PDF-1.4\nTexas resale certificate\nCustomer: Lone Star Laboratory\nReference: TX-RESALE-2026\n%%EOF'
  const fields = { customer, state: 'TX', reference: 'TX-RESALE-2026', valid_from: '2026-06-01', expires_on: '2026-07-31', file: file('texas-resale.pdf', pdf, 'application/pdf') }
  await h.api('certificate.collect', owner, { ...fields, state: 'ZZ' }, 400)
  await h.api('certificate.collect', owner, { ...fields, file: file('false.pdf', '<script>bad</script>', 'application/pdf') }, 400)
  const collected = await h.api('certificate.collect', owner, fields)
  const pending = await invoice('2026-06')
  assert.ok(pending.exceptions.some(x => x.code === 'exemption_certificate'))
  await h.api('certificate.review', { bearer: (await h.api('credential.issue', owner, { name: 'Certificate reader', scopes: ['prepare'] })).key }, { certificate: collected.certificate, decision: 'validated', review_note: 'An agent cannot validate' }, 403)
  await h.api('certificate.review', owner, { certificate: collected.certificate, decision: 'validated', review_note: 'Reviewed signed Texas resale certificate, customer identity, state and validity dates.' })
  await h.api('certificate.review', owner, { certificate: collected.certificate, decision: 'rejected', review_note: 'Cannot edit a decided record' }, 409)
  const download = await h.raw(`/app/certificates/${collected.certificate}`, { cookie: owner })
  assert.equal(download.status, 200); assert.equal(await download.text(), pdf)
  assert.equal((await h.raw(`/app/certificates/${collected.certificate}`)).status, 303)
  const texas = await issue(await invoice('2026-06'))
  assert.equal(texas.tax_cents, 0); assert.equal(texas.calculation.tax.certificate.id, collected.certificate)
  assert.equal(texas.calculation.tax.exempt, true)
  const frozen = texas.calculation
  // A Texas document never exempts New York sales.
  await policy('NY')
  const ny = await issue(await invoice('2026-07'))
  assert.equal(ny.tax_cents, 1000); assert.equal(ny.total_cents, 11000)
  // Public local scheduled-event door advances the job's clock; duplicate ticks send once.
  const tick = async day => {
    const result = await h.raw(`/cdn-cgi/local/scheduled?time=${Date.parse(`${day}T14:00:00Z`)}&cron=${encodeURIComponent('0 14 * * *')}`)
    assert.equal(result.status, 200, await result.text())
  }
  const notices = () => h.mails.filter(mail => String(mail.subject).includes('exemption certificate'))
  const count = notices().length
  await tick('2026-07-10')
  assert.equal(notices().length, count, 'owner policy starts disabled')
  await applyPolicy(h, owner, 'certificate.policy', { enabled: true })
  await tick('2026-07-10'); await tick('2026-07-10')
  assert.equal(notices().length, count + 1)
  assert.match(notices().at(-1).text, /TX.*expiring.*July 31, 2026/)
  await tick('2026-08-01'); await tick('2026-08-01')
  assert.equal(notices().length, count + 2)
  assert.match(notices().at(-1).text, /TX.*expired/)
  await policy('TX')
  const expired = await invoice('2026-08')
  assert.ok(expired.exceptions.some(x => x.code === 'exemption_certificate'))
  await h.api('invoice.approve', owner, { invoice: expired.id, acknowledge: true }, 409)
  assert.deepEqual((await h.api(`invoices/${texas.id}`, owner)).calculation, frozen)
  const renewed = await h.api('certificate.collect', owner, { ...fields, reference: 'TX-RESALE-RENEWED', valid_from: '2026-08-01', expires_on: '2027-07-31' })
  await h.api('certificate.review', owner, { certificate: renewed.certificate, decision: 'validated', review_note: 'Renewal signed and validated.' })
  const august = await invoice('2026-08')
  assert.equal(august.tax_cents, 0)
  await h.api('invoice.approve', owner, { invoice: august.id, acknowledge: true })
  // Another claim changes the recorded tax basis and invalidates exact-input approval.
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'NY', tax_mode: 'flat_rate', tax_rate: '10', tax_note: 'Changed jurisdiction' })
  await h.api('tax.review', owner, { revision: (await h.api('business', owner)).revision })
  await h.api('invoice.finalise', owner, { invoice: august.id, issue_date: '2026-09-01' }, 409)
  const detail = await h.api(`customers/${customer}`, owner)
  assert.equal(detail.certificates.length, 2)
  assert.ok(detail.certificateReminders.some(x => x.kind === 'expired' && x.status === 'accepted'))
  assert.match(await h.page(`/app/customers/${customer}`, owner), /TX-RESALE-RENEWED/)
  const audit = await h.api('audit', owner)
  assert.ok(audit.some(x => x.action === 'certificate.review' && x.subject === collected.certificate))
  const refusedCustomer=(await h.api('customer.create',owner,{external_id:'synthetic-nectar-certificate-refusal',name:'Synthetic missing certificate',billing_email:h.vars.OWNER_EMAIL})).id
  await h.api('exemption.claim',owner,{customer:refusedCustomer,state:'TX'})
  h.mailResponses.push({to:h.vars.OWNER_EMAIL,status:422,body:{message:'Synthetic certificate recipient refused'}})
  await tick('2026-08-02')
  const [reported]=(await h.api('job-runs',owner)).runs
  assert.equal(reported.jobs.find(job=>job.job==='certificate-reminders').status,'failed')
  assert.equal(reported.jobs.find(job=>job.job==='certificate-reminders').error_code,'job_reported_failure')
  assert.equal(reported.jobs.at(-1).status,'completed')
  assert.equal((await h.api(`customers/${refusedCustomer}`,owner)).certificateReminders[0].status,'rejected')
  const sends=h.mails.length
  await tick('2026-08-02');assert.equal(h.mails.length,sends,'a refused certificate reminder never resends')
  assert.deepEqual((await h.api(`invoices/${texas.id}`,owner)).calculation,frozen)
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: before.tax_jurisdiction, tax_mode: before.tax_mode, tax_rate: before.tax_rate, tax_note: before.tax_note })
  if (before.taxReady) await h.api('tax.review', owner, { revision: (await h.api('business', owner)).revision })
  console.log('TAX-002 state-scoped certificate custody, review, expiry, reminder and unchanged issued evidence passed')
  return { customer, certificate: renewed.certificate }
}
