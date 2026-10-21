import assert from 'node:assert/strict'
import { applyPolicy } from './policy-helper.mjs'

const month = index => `${2026 + Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`
const lines = invoice => invoice.lines.map(line => ({ kind: line.kind, price: line.price_id, cents: line.amount_cents, from: line.period_start, to: line.period_end, evidence: line.evidence }))

// CAT-001's real Worker/D1 billing clock. No database edits or calculated
// engine expectations: annual fees and each monthly usage amount are supplied
// independently below and compared with ordinary approved issued documents.
export async function intervalsFlow(h, owner, { onState = async () => {} } = {}) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  const price = async (suffix, fields) => {
    const product = (await api('product.create', { code: `calendar-${suffix}`, name: `Calendar ${suffix}` })).id
    return (await api('price.create', { product, taxable: false, ...fields })).id
  }
  const customer = (await api('customer.create', { external_id: 'synthetic-nectar-calendar-1', name: 'Calendar Research', billing_email: 'calendar@example.test' })).id
  const meter = (await api('meter.create', { code: 'calendar-calls', name: 'Calendar calls', unit_label: 'calls' })).id
  const platform = await price('platform', { kind: 'flat', unit_amount: '12000', billing_interval: 'annual', billing_timing: 'advance' })
  const usage = await price('usage', { kind: 'unit', unit_amount: '2', meter, billing_interval: 'monthly', billing_timing: 'arrears' })
  const addon = await price('addon', { kind: 'seat', unit_amount: '12000', billing_interval: 'annual', billing_timing: 'advance' })
  const invalidProduct = (await api('product.create', { code: 'calendar-invalid', name: 'Calendar invalid' })).id
  assert.equal((await api('price.create', { product: invalidProduct, kind: 'unit', meter, unit_amount: '2', billing_interval: 'monthly', billing_timing: 'advance' }, 400)).error, 'metered_usage_requires_arrears', 'Future consumption cannot become an invented advance charge')
  await h.advanceClock('2026-01-01T20:00:00Z')
  const subscription = (await api('subscription.create', { customer, start_date: '2026-01-01', term_months: 24, price: [platform, usage] })).id
  const initial = await api(`subscriptions/${subscription}`)
  assert.equal(initial.contract_end_date, '2028-01-01')
  assert.equal(initial.billing_anchor_date, '2026-01-01')
  const issued = [], usageInvoices = [], platformInvoices = []
  let firstOriginal
  for (let index = 0; index <= 24; index++) {
    const period = month(index)
    await h.advanceClock(`${period}-01T20:00:00Z`)
    if (index > 0) await api('usage.submit', { events: [{ event_id: `synthetic-nectar-calendar-usage-${index}`, customer: 'synthetic-nectar-calendar-1', meter: 'calendar-calls', quantity: String(index), occurred_at: `${month(index - 1)}-15T12:00:00Z` }] })
    if (index === 6) await api('subscription.addon', { subscription, price: addon, quantity: 1, effective_date: '2026-07-01' })
    let run = await api('billrun.prepare', { period })
    let drafts = (await api(`runs/${run.id}`)).invoices.filter(row => row.customer_id === customer)
    if ([0, 6, 12].includes(index)) {
      const before = await Promise.all(drafts.map(row => api(`invoices/${row.id}`)))
      run = await api('billrun.prepare', { period })
      drafts = (await api(`runs/${run.id}`)).invoices.filter(row => row.customer_id === customer)
      const after = await Promise.all(drafts.map(row => api(`invoices/${row.id}`)))
      const normalize = rows => rows.map(row => ({ key: row.calculation.inputs.billing.key, fingerprint: row.source_fingerprint, lines: lines(row), total: row.total_cents })).sort((a, b) => a.key.localeCompare(b.key))
      assert.deepEqual(normalize(after), normalize(before), 'Re-preparation conserves exact components, fingerprints and cents')
    }
    for (const draft of drafts) {
      await api('invoice.approve', { invoice: draft.id, acknowledge: true })
      await api('invoice.finalise', { invoice: draft.id, issue_date: `${period}-01` })
      const invoice = await api(`invoices/${draft.id}`)
      issued.push(invoice)
      const metered = invoice.lines.filter(line => line.price_id === usage)
      if (metered.length) {
        usageInvoices.push(invoice)
        assert.equal(metered.reduce((sum, line) => sum + line.amount_cents, 0), index * 200, 'Each closed month bills its independently supplied usage once')
        assert.equal(invoice.calculation.inputs.billing.terms.timing, 'arrears')
      }
      const base = invoice.lines.find(line => line.price_id === platform)
      if (base) {
        platformInvoices.push(invoice)
        assert.equal(base.amount_cents, 1200000)
        assert.ok(!invoice.exceptions.some(exception=>exception.code==='missing_usage'),'An advance platform invoice does not demand future monthly consumption')
        assert.equal(invoice.issue_date, index === 0 ? '2026-01-01' : '2027-01-01')
        const source = await api(`revenue/${invoice.id}`), schedule = source.schedules.find(row => row.lineId === base.id)
        assert.deepEqual(schedule.entries.map(row => row.amountCents), Array(12).fill(100000), 'Annual advance recognizes exactly $1,000 per service month')
        if (index === 0) firstOriginal = { calculation: invoice.calculation, lines: lines(invoice) }
      }
      const added = invoice.lines.find(line => line.price_id === addon)
      if (added) assert.equal(added.amount_cents, index === 6 ? 604932 : 1200000, 'Annual addon uses 184/365 days once, then its full cotermed year')
    }
    const repeated = await api('billrun.prepare', { period })
    assert.equal((await api(`runs/${repeated.id}`)).invoices.filter(row => row.customer_id === customer).length, 0, 'Issued components cannot be billed again')
    if (index === 4) {
      const report = await api(`revenue?period=2026-05&customer=${customer}`)
      assert.equal(report.months[0].openingDeferredLiabilityCents, 800000, 'Four earned service months leave exactly $8,000 deferred')
    }
  }
  assert.equal(platformInvoices.length, 2)
  assert.equal(usageInvoices.length, 24)
  const first = await api(`invoices/${platformInvoices[0].id}`)
  assert.deepEqual({ calculation: first.calculation, lines: lines(first) }, firstOriginal, 'Later addons and billing never rewrite issued evidence')
  const final = await api(`subscriptions/${subscription}`)
  assert.equal(platformInvoices.length,2,'Two annual platform charges retain their original service windows')
  assert.equal(usageInvoices.length,24,'All 24 independently supplied usage months are charged once')
  assert.equal(final.invoices.filter(invoice => invoice.status === 'issued').length, 25, 'Same-day annual fees and the addon stub share the corresponding monthly usage invoice')
  const revenue = await api(`revenue?from=2026-01&to=2028-01&customer=${customer}`)
  assert.equal(revenue.months.at(-1).deferredLiabilityCents, 0)
  assert.equal(revenue.netBillingsCents, issued.reduce((sum, invoice) => sum + invoice.subtotal_cents, 0))
  const csv = await h.page(`/app/exports/revenue.csv?from=2026-01&to=2028-01&customer=${customer}`, owner)
  assert.match(csv, /12000\.00/)
  const journal = await api(`revenue-journal?from=2026-01&to=2028-01&customer=${customer}`)
  assert.ok(journal.periods.every(row => row.debitCents === row.creditCents), 'Every monthly deferred journal balances')
  const mrr=await api(`reports/mrr?period=2026-01&customer=${customer}`)
  assert.equal(mrr.totalCents,100200,'Annual service contributes one month plus actual monthly consumption')
  const mrrSource=await api(`reports/mrr/${platformInvoices[0].id}?period=2026-01&customer=${customer}`)
  assert.equal(mrrSource.totalCents,100000)
  assert.equal(mrrSource.components.reduce((sum,row)=>sum+row.amountCents,0),100000)
  assert.equal(mrr.series.find(row=>row.period==='2026-01').amountCents,100200)
  await onState('annual-issued', subscription, platformInvoices[0].id)
  await onState('anniversary-issued', subscription, platformInvoices[1].id)
  await onState('coterm-issued', subscription, issued.find(invoice => invoice.issue_date === '2026-07-01').id)
  await intervalCadencesFlow(h, owner, { price, api, onState })
  await mixedMonthlyInvoiceFlow(h, owner, { price, api, onState })
}

async function mixedMonthlyInvoiceFlow(h, owner, { price, api, onState }) {
  const previous=await api('business')
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'flat_rate',tax_rate:'10',tax_note:'Same-due-date invoice composition'})
  await api('tax.review',{revision:(await api('business')).revision})
  const customer=(await api('customer.create',{external_id:'synthetic-nectar-calendar-mixed',name:'Seat and usage calendar',billing_email:'seats@calendar.example'})).id
  const meter=(await api('meter.create',{code:'calendar-monthly-mixed',name:'Monthly mixed calls',unit_label:'calls'})).id
  const seats=await price('monthly-advance-seats',{kind:'seat',unit_amount:'10.05',taxable:true,billing_interval:'monthly',billing_timing:'advance'})
  const usage=await price('monthly-arrears-calls',{kind:'unit',unit_amount:'0.05',meter,taxable:true,billing_interval:'monthly',billing_timing:'arrears'})
  await h.advanceClock('2034-09-01T20:00:00Z')
  const subscription=(await api('subscription.create',{customer,start_date:'2034-09-01',term_months:12,price:[seats,usage],quantity:['1','']})).id
  const initialRun=await api('billrun.prepare',{period:'2034-09'})
  const first=(await api(`runs/${initialRun.id}`)).invoices.filter(row=>row.customer_id===customer)
  assert.equal(first.length,1)
  await api('invoice.approve',{invoice:first[0].id,acknowledge:true})
  await api('invoice.finalise',{invoice:first[0].id,issue_date:'2034-09-01'})
  await api('usage.submit',{events:[{event_id:'synthetic-nectar-calendar-mixed-usage',customer:'synthetic-nectar-calendar-mixed',meter:'calendar-monthly-mixed',quantity:'1',occurred_at:'2034-09-15T12:00:00Z'}]})
  await h.advanceClock('2034-10-01T20:00:00Z')
  const run=await api('billrun.prepare',{period:'2034-10'})
  const drafts=(await api(`runs/${run.id}`)).invoices.filter(row=>row.customer_id===customer)
  assert.equal(drafts.length,1,'October advance seats and September arrears usage form one invoice due October 1')
  const invoice=await api(`invoices/${drafts[0].id}`)
  const seat=invoice.lines.find(line=>line.price_id===seats),calls=invoice.lines.find(line=>line.price_id===usage)
  assert.deepEqual([seat.period_start,seat.period_end,seat.amount_cents],['2034-10-01','2034-11-01',1005])
  assert.deepEqual([calls.period_start,calls.period_end,calls.amount_cents],['2034-09-01','2034-10-01',5])
  assert.equal(seat.evidence.calendar.terms.timing,'advance')
  assert.equal(calls.evidence.calendar.terms.timing,'arrears')
  assert.equal(invoice.calculation.inputs.billing.serviceWindows.length,2,'Saved source retains both original service calendars')
  assert.deepEqual([invoice.subtotal_cents,invoice.tax_cents,invoice.total_cents],[1010,101,1111],'Tax rounds once on the complete invoice, rather than once for each service window')
  await api('invoice.approve',{invoice:invoice.id,acknowledge:true})
  await api('invoice.finalise',{invoice:invoice.id,issue_date:'2034-10-01'})
  const issued=await api(`invoices/${invoice.id}`)
  assert.deepEqual(issued.lines,invoice.lines,'Issue retains each exact service line and its source calendar')
  await onState('mixed-issued', subscription, issued.id)
  const repeat=await api('billrun.prepare',{period:'2034-10'})
  assert.equal((await api(`runs/${repeat.id}`)).invoices.filter(row=>row.customer_id===customer).length,0,'Both service windows are claimed together and cannot issue again')
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:previous.tax_jurisdiction,tax_mode:previous.tax_mode,tax_rate:previous.tax_rate,tax_note:previous.tax_note})
  await api('tax.review',{revision:(await api('business')).revision})
}

async function intervalCadencesFlow(h, owner, { price, api, onState }) {
  // Distinct customers keep annual, six-month, quarterly, weekly and daily
  // denominators independent. Jan31 must return to Mar31 after February.
  const cases = [
    { suffix: 'quarter', unit: 'quarterly', amount: '900', start: '2032-01-31', end: '2032-04-30', due: '2032-04', cents: 90000 },
    { suffix: 'half', unit: 'semiannual', amount: '600', start: '2032-01-31', end: '2032-07-31', due: '2032-07', cents: 60000 },
    { suffix: 'two-months', unit: 'month', count: 2, amount: '200', start: '2032-01-31', end: '2032-03-31', due: '2032-03', cents: 20000 },
    { suffix: 'week', unit: 'weekly', amount: '70', start: '2032-01-31', end: '2032-02-07', due: '2032-02', cents: 7000 },
    { suffix: 'day', unit: 'day', count: 2, amount: '20', start: '2032-01-31', end: '2032-02-02', due: '2032-02', cents: 2000 },
  ]
  for (const row of cases) {
    const customer = (await api('customer.create', { external_id: `synthetic-nectar-calendar-${row.suffix}`, name: `Calendar ${row.suffix}`, billing_email: `${row.suffix}@calendar.example` })).id
    const id = await price(row.suffix, { kind: 'flat', unit_amount: row.amount, billing_interval: row.unit, interval_count: row.count ?? 1, billing_timing: 'arrears' })
    const sub = (await api('subscription.create', { customer, start_date: row.start, billing_anchor_date: row.start, price: [id] })).id
    await h.advanceClock(`${row.end}T20:00:00Z`)
    const run = await api('billrun.prepare', { period: row.due })
    const drafts = (await api(`runs/${run.id}`)).invoices.filter(invoice => invoice.customer_id === customer)
    const first = await api(`invoices/${drafts.find(invoice => invoice.period_start === row.start).id}`)
    assert.equal(first.period_end, row.end)
    assert.equal(first.total_cents, row.cents)
    await api('invoice.approve', { invoice: first.id, acknowledge: true })
    await api('invoice.finalise', { invoice: first.id, issue_date: row.end })
    await onState('cadence-issued', sub, first.id)
  }
}
