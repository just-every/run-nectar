import assert from 'node:assert/strict'
import { file } from './harness.mjs'
import { stripeHistoryCapture } from '../fixtures/stripe-history.mjs'
import { discountedCaptureFlow } from './normalized-discount-capture.mjs'
import { csvRows } from './financial-reports.mjs'

// The captured contract changes independently of its invoice consideration.
// Every record enters through the uploaded move-in door, never database writes.
function capture() {
  const data = stripeHistoryCapture(), subscription = data.subscriptions.data[0], flat = data.prices.data[0]
  const seat = { ...structuredClone(flat), id: 'synthetic-nectar-normalized-seat', unit_amount: 1000, metadata: { nectar_kind: 'seat' } }
  data.prices.data.push(seat)
  subscription.items.data[0].quantity = 2
  subscription.items.data.push({ id: 'synthetic-nectar-normalized-seat-item', price: seat, quantity: 3 })
  const annual = data.invoices.data.at(-1)
  annual.total = annual.amount_paid = annual.lines.data[0].amount = annual.lines.data[0].amount_excluding_tax = 120000
  annual.lines.data[0].price.unit_amount = 120000
  data.payments.data.at(-1).amount = data.payments.data.at(-1).amount_captured = 120000
  const unix = day => Date.parse(`${day}T00:00:00Z`) / 1000
  const states = [
    ['2025-01-01', 1, flat, { trial_end: unix('2025-02-15') }],
    ['2025-04-01', 1, flat, { discount: { id: 'synthetic-nectar-normalized-discount', start: unix('2025-04-01'), end: unix('2025-07-01'), coupon: { id: 'synthetic-nectar-normalized-coupon', percent_off: 10 } } }],
    ['2025-09-01', 2, flat, {}],
    ['2025-11-01', 2, flat, { status: 'canceled', ended_at: unix('2025-11-01') }],
    ['2025-12-01', 2, flat, {}],
    ['2026-03-01', 2, annual.lines.data[0].price, {}],
    ['2026-06-01', 2, flat, {}],
  ]
  data.subscription_events.data = states.map(([date, quantity, price, extra], index) => ({
    id: `synthetic-nectar-normalized-event-${index}`, object: 'event', type: index ? 'customer.subscription.updated' : 'customer.subscription.created', created: unix(date),
    data: { object: { ...structuredClone(subscription), ...extra, items: { object: 'list', has_more: false, data: [
      { id: subscription.items.data[0].id, price, quantity }, subscription.items.data[1],
    ] } } },
  }))
  const ended = { ...structuredClone(subscription), id: 'synthetic-nectar-ended-subscription', items: {object:'list',has_more:false,data:[{id:'synthetic-nectar-ended-item',quantity:1,price:{...flat,id:'synthetic-nectar-ended-price',unit_amount:5000}}]} }
  data.subscription_events.data.push(...['2025-01-01','2025-03-01'].map((date,index)=>({
    id:`synthetic-nectar-ended-event-${index}`,object:'event',type:index?'customer.subscription.deleted':'customer.subscription.created',created:unix(date),
    data:{object:{...ended,...(index?{status:'canceled',ended_at:unix(date)}:{})}},
  })))
  for (const [name, value] of Object.entries(data)) if (name !== 'manifest') data.manifest.files[name].count = value.data.length
  return data
}

export async function normalizedMetricsFlow(h, owner, onState = async () => {}) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  await api('business.configure', { ...(await api('business')), timezone: 'UTC' })
  await h.advanceClock('2026-08-01T16:00:00Z')
  const data = capture(), files = Object.fromEntries(Object.entries(data).map(([name, value]) => [name, file(`${name}.json`, JSON.stringify(value), 'application/json')]))
  const preview = await api('import.preview', files)
  assert.deepEqual(preview.rejected, [])
  await api('import.apply', { ...files, fingerprint: preview.fingerprint })
  const customer = (await api('customers')).find(c => c.external_id === 'synthetic-nectar-1').id
  const subscription = (await api(`customers/${customer}`)).subscriptions[0].id
  // Independent cents from the captured contracts: $100 + three $10 seats,
  // then a 10% discount, two platforms, a cancellation, and an annual fee.
  const expected = [5000,18000,13000,11700,11700,11700,13000,13000,23000,23000,0,23000,23000,23000,23000,23000,23000,23000]
  for (const [index, cents] of expected.entries()) {
    const month = new Date(Date.UTC(2025, index, 1)).toISOString().slice(0, 7)
    for (const [metric, value] of [['normalized-mrr', cents], ['normalized-arr', cents * 12]]) {
      const report = await api(`reports/${metric}?period=${month}&customer=${customer}`)
      assert.equal(report.totalCents, value, `${metric} ${month}: independent captured terms`)
      assert.equal(report.entries.length, 2,'Ended source subscriptions remain in the historical report')
      for(const entry of report.entries) {
        const source = await api(entry.href.replace('/app/', ''))
        assert.equal(source.totalCents, entry.amountCents)
        assert.equal(source.components.reduce((sum, c) => sum + c.amountCents, 0), entry.amountCents)
        assert.equal(source.sourceProvider, 'stripe')
        assert.ok(source.normalized.source.href.includes('#history-'))
        assert.ok(!JSON.stringify(source).includes('synthetic-nectar-private-7'))
      }
    }
  }
  const historical = await api(`reports/normalized-mrr?period=2026-06&customer=${customer}`)
  assert.deepEqual(historical.series.map(row => row.amountCents), expected)
  await api('subscription.adopt', { subscription, cutover_start: '2026-07-01', acknowledge_unreconciled: true })
  const run = await api('billrun.prepare', { period: '2026-07' })
  const invoice = (await api(`runs/${run.id}`)).invoices.find(row => row.subscription_id === subscription)
  await api('invoice.approve', { invoice: invoice.id, acknowledge: true })
  await api('invoice.finalise', { invoice: invoice.id, issue_date: '2026-08-01' })
  for (const [metric, amount] of [['normalized-mrr',23000],['normalized-arr',276000]]) {
    const report = await api(`reports/${metric}?period=2026-07&customer=${customer}`)
    assert.equal(report.totalCents, amount)
    assert.deepEqual(report.series.map(row=>row.amountCents), [...expected,23000].map(value=>metric==='normalized-mrr'?value:value*12), 'Adoption preserves all source months and continues with native terms')
    const source = await api(report.entries[0].href.replace('/app/', ''))
    assert.equal(source.sourceProvider, 'nectar')
    const csv = await h.raw(`/app/exports/reports/${metric}.csv?period=2026-07&customer=${customer}`, { cookie: owner })
    assert.equal(csv.status, 200)
    assert.equal(csvRows(await csv.text()).find(row=>row.source==='TOTAL').amount, (amount/100).toFixed(2))
    await onState({ label: metric, path: `/app/reports/${metric}?period=2026-07&customer=${customer}`, amount })
    await onState({ label: `${metric}-source`, path: report.entries[0].href, amount })
  }
  const billed = await api(`reports/mrr?period=2026-07&customer=${customer}`)
  assert.equal(billed.totalCents,33000,'Billed recurring retains native 23000 cents plus the captured annual invoice allocation of 10000 cents')
  await onState({label:'billed-recurring',path:`/app/reports/mrr?period=2026-07&customer=${customer}`,amount:33000})
  await onState({label:'billed-recurring-source',path:billed.entries.find(entry=>entry.sourceProvider!=='stripe').href,amount:23000})
  await onState({label:'source-history',path:historical.entries[0].href,amount:23000})

  const nativeCustomer = (await api('customer.create', { external_id:'synthetic-nectar-normalized-native',name:'Evergreen Research',billing_email:['billing','evergreen.example'].join(String.fromCharCode(64)) })).id
  const makePrice = async (code, amount, interval) => {
    const product = (await api('product.create',{code,name:`Research ${interval}`})).id
    return (await api('price.create',{product,kind:'flat',unit_amount:amount,billing_interval:interval,billing_timing:'advance'})).id
  }
  const annual = await makePrice('synthetic-nectar-normalized-annual','100','annual')
  const weekly = await makePrice('synthetic-nectar-normalized-weekly','10','weekly')
  const daily = await makePrice('synthetic-nectar-normalized-daily','1','daily')
  const quarterly = await makePrice('synthetic-nectar-normalized-quarter','300','quarterly')
  await api('subscription.create',{customer:nativeCustomer,start_date:'2026-01-01',price:[annual,weekly,quarterly,daily]})
  const native = await api(`reports/normalized-mrr?period=2026-06&customer=${nativeCustomer}`)
  // $100/12 + $10*52/12 + $300/3, each displayed item rounded once.
  assert.equal(native.totalCents,833+4333+10000+3042)
  const nativeArr = await api(`reports/normalized-arr?period=2026-06&customer=${nativeCustomer}`)
  assert.equal(nativeArr.totalCents,10000+52000+120000+36500,'ARR multiplies exact fractions before rounding')
  const source = await api(native.entries[0].href.replace('/app/',''))
  assert.ok(source.normalized.snapshot.components.some(c=>c.exactMrrCents.numerator==='2500'&&c.exactMrrCents.denominator==='3'))
  await onState({label:'nonmonthly-source',path:native.entries[0].href,amount:native.totalCents})
  const credential = (await api('credential.issue',{name:'Metric reader',scopes:['prepare']})).key
  await h.api(`reports/normalized-mrr?customer=${customer}&period=2026-07`,{bearer:credential})
  const id = (await api('credentials')).find(row=>row.name==='Metric reader').id
  await api('credential.revoke',{key:id})
  await h.api(`reports/normalized-mrr?customer=${customer}&period=2026-07`,{bearer:credential},undefined,401)
  await h.api(native.entries[0].href.replace('/app/',''),undefined,undefined,401)
  await api(`reports/normalized-mrr/${subscription}?period=2026-07&customer=${nativeCustomer}`,undefined,404)
  const beforeReplay = await api(`subscriptions/${subscription}`)
  await api('import.apply',{...files,fingerprint:preview.fingerprint})
  assert.equal((await api(`reports/normalized-mrr?period=2026-07&customer=${customer}`)).totalCents,23000,'Capture replay creates no duplicate or restored source authority')
  assert.deepEqual(await api(`subscriptions/${subscription}`),beforeReplay)
  const erasure = await api('erasure.request',{customer})
  const verification = new URL(h.mails.at(-1).text.match(/https?:\/\/[^\s"<]+\/erase\/[a-f0-9]{64}/)[0]).pathname
  assert.equal((await h.raw(verification,{form:new URLSearchParams({confirm:'yes'})})).status,200)
  await api('erasure.approve',{request:erasure.id,confirm:true})
  await api(`reports/normalized-mrr?period=2026-07&customer=${customer}`,undefined,404)
  await api('import.apply',{...files,fingerprint:preview.fingerprint},409)
  const anonymous = await api('reports/normalized-mrr?period=2026-07')
  assert.equal(anonymous.entries.some(row=>row.customerId===customer),false,'Erasure and replay cannot expose retained contract operands')
  await discountedCaptureFlow(h, owner, onState)
  console.log('Normalized native and captured history, adoption, independent MRR and ARR, fractions, sources, CSV and authority passed')
}
