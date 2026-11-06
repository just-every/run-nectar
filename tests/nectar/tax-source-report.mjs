// Ordinary source creation and read-only quarter reconciliation through Worker
// and D1 doors. No tax provider or filing authority is simulated here.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { applyPolicy } from './policy-helper.mjs'
import { csvRows } from './financial-reports.mjs'
import { file } from './harness.mjs'

export const harnessOptions = () => ({ assets: true, localTime: '2026-10-15T20:00:00Z' })
export async function taxSourceReportFlow(h, owner) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  const email = (await api('me')).email
  const customer = (await api('customer.create', { external_id: 'synthetic-nectar-106', name: 'Quarter source customer', billing_email: email, address: 'Oregon customer destination must not determine declared jurisdiction' })).id
  const exempt = (await api('customer.create', { external_id: 'synthetic-nectar-107', name: 'Certificate source customer', billing_email: email })).id
  const other = (await api('customer.create', { external_id: 'synthetic-nectar-108', name: 'Other quarter customer', billing_email: email })).id
  const policy = async state => {
    await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: state, tax_mode: 'flat_rate', tax_rate: '10', tax_note: 'Reviewed declared source rate' })
    await api('tax.review', { revision: (await api('business')).revision })
  }
  await policy('TX')
  const certificate = await api('certificate.collect', { customer: exempt, state: 'TX', reference: 'synthetic-nectar-106', valid_from: '2026-01-01', expires_on: '2026-12-31', file: file('synthetic-nectar-106.pdf', '%PDF-1.4\nSynthetic certificate\n%%EOF', 'application/pdf') })
  await api('certificate.review', { certificate: certificate.certificate, decision: 'validated', review_note: 'Reviewed source customer and validity' })
  const issue = async (who, day, taxable, nonTaxable, finalise = true) => {
    const charges = []
    for (const [amount, taxed] of [[taxable, true], [nonTaxable, false]]) if (amount) charges.push((await api('charge.add', { customer: who, amount, description: 'Reviewed source service', taxable: taxed, effective_date: day })).charge)
    const draft = await api('invoice.manual', { customer: who, charges, service_date: day })
    if (finalise) {
      await api('invoice.approve', { invoice: draft.id, acknowledge: true })
      await api('invoice.finalise', { invoice: draft.id, issue_date: day })
    }
    return api(`invoices/${draft.id}`)
  }
  const outside = await issue(customer, '2026-06-30', '11', 0)
  const first = await issue(customer, '2026-07-01', '100', '20')
  const certificateInvoice = await issue(exempt, '2026-08-01', '50', '5')
  const reversed = await issue(customer, '2026-08-02', '30', 0)
  const draft = await issue(customer, '2026-08-03', '999', 0, false)
  await policy('NY')
  const last = await issue(customer, '2026-09-30', '200', 0)
  const next = await issue(customer, '2026-10-01', '13', 0)
  assert.deepEqual([first.tax_cents, certificateInvoice.tax_cents, reversed.tax_cents, last.tax_cents], [1000, 0, 300, 2000])
  await h.advanceClock('2026-09-30T23:59:59Z')
  await applyPolicy(h, owner, 'credit.policy', { two_person_above: '1000' })
  const replacement = await api('invoice.void', { invoice: reversed.id, basis: reversed.source_fingerprint, reason: 'Reviewed full source correction', confirm: true })
  const credit = await api('credit.issue', { invoice: first.id, amount: '11', reason: 'Ordinary credit with unknown tax attribution' })
  await h.advanceClock('2026-10-01T07:00:00Z')
  await api('credit.issue', { invoice: outside.id, amount: '1', reason: 'Credit outside selected local quarter' })
  const path = 'reports/tax-sources?period=2026-Q3'
  const read = () => api(path)
  const before = await read()
  assert.equal(before.timezone, 'America/Los_Angeles')
  assert.deepEqual(before.groups.map(g => g.jurisdiction), ['NY', 'TX'])
  // Independent values derive from the issued invoice lines above, with no
  // proportional allocation of the 11-dollar ordinary credit.
  assert.deepEqual(before.totals, { taxableBaseCents: 33000, exemptBaseCents: 5000, nonTaxableBaseCents: 2500, unknownBaseCents: 0, originalTaxCents: 3300, attributedTaxAdjustmentCents: -300, knownTaxCents: 3000, attributedCreditSubtotalCents: 3000, unattributedCreditCents: 1100 })
  const tx = before.groups.find(g => g.jurisdiction === 'TX'), ny = before.groups.find(g => g.jurisdiction === 'NY')
  assert.deepEqual([tx.taxableBaseCents, tx.exemptBaseCents, tx.nonTaxableBaseCents, tx.knownTaxCents, ny.taxableBaseCents, ny.knownTaxCents], [13000,5000,2500,1000,20000,2000])
  assert.deepEqual(before.entries.filter(e => e.kind === 'invoice').map(e => e.id).sort(), [first.id, certificateInvoice.id, reversed.id, last.id].sort())
  assert.ok(!before.entries.some(e => [draft.id, outside.id, next.id, replacement.id].includes(e.id)))
  const unknown = before.entries.find(e => e.taxState === 'unknown_credit')
  assert.equal(unknown.amountCents, 1100); assert.equal(unknown.knownTaxCents, 0)
  assert.equal(before.entries.find(e => e.id === replacement.credit).knownTaxCents, -300)
  const financialSnapshot = async () => ({ invoices: await Promise.all([first, certificateInvoice, reversed, last, outside, next, draft].map(i => api(`invoices/${i.id}`))), payments: await api('payments'), tax: await api('reports/tax?period=2026-09'), audit: await api('audit') })
  const original = await financialSnapshot()
  const csvPath = '/app/exports/reports/tax-sources.csv?period=2026-Q3'
  const response = await h.raw(csvPath, { cookie: owner })
  assert.equal(response.status, 200)
  const rows = csvRows(await response.text()), total = rows.find(row => row.source === 'TOTAL')
  for (const [field, value] of Object.entries(before.totals)) {
    const cents = text => Math.round(Number(text.replace(/^'/, '')) * 100)
    assert.equal(cents(total[field]), value, `CSV total ${field}`)
    assert.equal(rows.filter(row => row.source_kind !== 'total').reduce((sum, row) => sum + cents(row[field]), 0), value, `CSV source sum ${field}`)
  }
  const pageHtml = await h.page('/app/reports/tax-sources?period=2026-Q3', owner)
  for (const entry of before.entries) {
    assert.ok(pageHtml.includes(entry.href.replaceAll('&','&amp;')))
    const source = await api(entry.href.replace('/app/', ''))
    assert.deepEqual(source.entry, entry)
    const invoice = original.invoices.find(i => i.id === entry.invoiceId)
    assert.equal(source.evidence.original.taxCents, invoice.tax_cents)
    assert.equal(source.evidence.original.fingerprint, invoice.source_fingerprint)
    assert.deepEqual(source.evidence.original.lines.map(l => [l.id,l.amount_cents,l.taxable]), invoice.lines.map(l => [l.id,l.amount_cents,l.taxable]))
    if (entry.kind === 'invoice') assert.equal(source.evidence.original.lines.reduce((sum,l) => sum+l.amount_cents,0), entry.taxableBaseCents+entry.exemptBaseCents+entry.nonTaxableBaseCents)
    await h.page(entry.href, owner)
  }
  await api(`reports/tax-sources/${next.id}?period=2026-Q3`, undefined, 404)
  await api(`reports/tax-sources/${first.id}?period=2026-Q3&customer=${other}`, undefined, 404)
  for (const query of ['period=2026-Q5','period=2026-07','period=2026-Q3&period=2026-Q4','bucket=current']) {
    await api(`reports/tax-sources?${query}`, undefined, 400)
    assert.equal((await h.raw(`/app/exports/reports/tax-sources.csv?${query}`, {cookie:owner})).status, 400)
  }
  assert.deepEqual((await api(`reports/tax-sources?period=2026-Q3&customer=${other}`)).entries, [])
  assert.deepEqual(await financialSnapshot(), original, 'Report, source and CSV reads change no financial records or audits')
  const sourcePath = before.entries[0].href
  const role = await api('role.define', { name: 'Tax source reviewer', capabilities: ['read.reports', 'export'] })
  const member = await api('access.give', { email: email.replace(/^[^@]+/, 'synthetic-nectar-109'), name: 'Source report accountant', role: 'custom', custom_role: role.id })
  const accountant = await h.signIn(email.replace(/^[^@]+/, 'synthetic-nectar-109'), {requested:true})
  assert.deepEqual(await h.api(path, accountant), before)
  const reader = await api('credential.issue', { name: 'Source reader', scopes: ['prepare'] })
  const readerWho = {bearer:reader.key}, usageWho = {bearer:(await api('credential.issue', {name:'Usage only',scopes:['usage']})).key}
  assert.deepEqual(await h.api(path, readerWho), before)
  for (const who of [undefined, usageWho]) {
    const status = who ? 403 : 401
    await h.api(path, who, undefined, status)
    await h.api(sourcePath.replace('/app/',''), who, undefined, status)
    assert.equal((await h.raw(csvPath, who ?? {})).status, who ? 403 : 303)
  }
  assert.equal((await h.raw(csvPath, readerWho)).status, 403, 'Report read authority grants no export')
  await api('credential.revoke', {key:reader.id})
  await h.api(path, readerWho, undefined, 401)
  await h.api(sourcePath.replace('/app/',''), readerWho, undefined, 401)
  await api('role.update', { role: role.id, revision: 1, capabilities: ['read.customers'] })
  await h.api(path, accountant, undefined, 403)
  await h.api(sourcePath.replace('/app/',''), accountant, undefined, 403)
  assert.equal((await h.raw(csvPath, {cookie:accountant})).status, 403, 'Current role is rechecked on export')

  await policy('WA')
  const record = await api(`customers/${exempt}`)
  await api('customer.update', { customer: exempt, revision:record.revision, name:record.name, billing_email:email, tax_exempt:false, address:'Changed destination' })
  assert.deepEqual(await read(), before, 'Policy and exemption changes cannot rewrite issued tax evidence')
  for (const saved of original.invoices) {
    const current = await api(`invoices/${saved.id}`)
    assert.deepEqual(current.lines,saved.lines); assert.deepEqual(current.calculation,saved.calculation)
  }
  await browserProof(h, owner, sourcePath, 'known')
  const mailStart = h.mails.length
  const request = await api('erasure.request', { customer: exempt })
  const mail = h.mails.slice(mailStart).find(item => [item.to].flat().includes(email))
  const erasePath = new URL(`${mail.text ?? ''} ${mail.html ?? ''}`.match(/https?:\/\/[^\s"<]+\/erase\/[a-f0-9]{64}/)[0]).pathname
  assert.equal((await h.raw(erasePath, { form: new URLSearchParams({confirm:'yes'}) })).status, 200)
  await api('erasure.approve', {request:request.id, confirm:true})
  const erased = await read(), missing = erased.groups.find(g => g.jurisdiction === null)
  assert.ok(missing, 'Erased frozen jurisdiction stays missing rather than being inferred from the current policy')
  assert.equal(missing.unknownBaseCents, 5500)
  assert.equal(erased.totals.knownTaxCents, 3000)
  const erasedEntry = erased.entries.find(e => e.id === certificateInvoice.id)
  assert.equal(erasedEntry.customerName, 'Erased customer'); assert.equal(erasedEntry.baseState, 'unknown')
  const erasedSource = await api(erasedEntry.href.replace('/app/',''))
  assert.ok(!JSON.stringify(erasedSource).includes('Certificate source customer'))
  assert.ok(!JSON.stringify(erasedSource).includes('Changed destination'))
  assert.deepEqual(await read(), erased, 'Replayed reads cannot resurrect erased source facts')
  await browserProof(h, owner, erasedEntry.href, 'missing')
  console.log('PROBE TAX-003 native quarter: API, page, source and CSV equal frozen bases 33000, 5000, 2500 and tax 3300 less attributed 300; ordinary credit 1100 remains unnetted')
  console.log('PROBE TAX-003 authority: current role, revoked credential, source membership and export refusals preserve financial records')
  return { customer, exempt, invoice:first.id, credit:credit.credit, member:member.id }
}

async function browserProof(h, owner, sourcePath, state) {
  const directory = process.env.NECTAR_EVIDENCE_DIR ?? '.evidence/tax-sources'
  await mkdir(directory, {recursive:true})
  const browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH} : {}),args:['--no-sandbox','--use-mock-keychain','--password-store=basic']})
  try {
    const context = await browser.newContext()
    await context.addCookies(owner.split('; ').map(value => {const i=value.indexOf('=');return {name:value.slice(0,i),value:value.slice(i+1),url:h.origin}}))
    const page = await context.newPage()
    for (const width of [1440,390]) for (const [name,path] of [['report','/app/reports/tax-sources?period=2026-Q3'],['source',sourcePath]]) {
      await page.setViewportSize({width,height:950}); await page.goto(`${h.origin}${path}`)
      await page.getByRole('heading',{name:name==='report'?'Declared tax sources':'Declared tax source',exact:true}).waitFor()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth>innerWidth),false,`${name} fits ${width}`)
      if (width===1440) {
        if(name==='report') {
          await page.getByRole('heading',{name:'TX',exact:true}).waitFor();await page.getByRole('heading',{name:'NY',exact:true}).waitFor()
          await page.getByRole('link',{name:'Download source CSV'}).waitFor()
          assert.ok((await page.locator('main').innerText()).includes('Unknown, unnetted'))
        }
        assert.deepEqual(await page.locator('main').evaluate(root=>[...root.querySelectorAll('p,h1,h2,h3,label,input,button,td,th,a,summary')].filter(e=>parseFloat(getComputedStyle(e).fontSize)<13).map(e=>e.tagName)),[])
      }
      await page.screenshot({path:`${directory}/${width}-${state}-${name}.png`,fullPage:true})
      console.log(`BROWSER TAX-003 ${width} ${state} ${name}`)
    }
  } finally {await browser.close()}
}
