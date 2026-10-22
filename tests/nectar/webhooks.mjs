// DEV-001: signed outbound webhooks through the public doors, delivered to the
// receiving app in examples/webhook-receiver over real HTTP (the Worker's request
// for *.webhooks.test is the network edge). An hour-long outage during a bill run,
// retries spanning more than three days, signature checks, replay, secret
// rotation with an overlap window, forged-delivery refusal, the INT-003 failure
// email and DEV-005 event-time metadata on invoice.paid.
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { startReceiver } from '../../examples/webhook-receiver/receiver.mjs'

const T0 = Date.parse('2026-08-01T17:00:00Z'), MINUTE = 60_000
let receiver

async function forward(request) {
  const url = new URL(request.url)
  if (url.hostname === 'dead.webhooks.test') return new Response('down for good', { status: 500 })
  const headers = Object.fromEntries([...request.headers].filter(([name]) => name.startsWith('nectar-') || name === 'content-type'))
  const answer = await fetch(`http://127.0.0.1:${new URL(receiver.url).port}${url.pathname}`, { method: request.method, headers, body: await request.text() })
  return new Response(answer.status === 204 ? null : await answer.text(), { status: answer.status })
}

export const harnessOptions = () => ({ localTime: new Date(T0).toISOString(), webhookFetch: forward })

export async function webhooksFlow(h, owner) {
  receiver = await startReceiver()
  try { await journey(h, owner) } finally { await receiver.close() }
}

async function journey(h, owner) {
  const api = (path, who = owner, body, status) => h.api(path, who, body, status)
  const tick = async at => { const response = await h.raw(`/cdn-cgi/local/scheduled?time=${at}&cron=${encodeURIComponent('* * * * *')}`); assert.equal(response.status, 200, await response.text()) }
  const waitFor = async (what, test) => { for (let i = 0; i < 300; i++) { const value = await test(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)) } assert.fail(`timed out waiting for ${what}`) }
  const deliveries = () => api('webhooks/deliveries')
  const attempted = () => waitFor('every delivery attempted', async () => { const rows = await deliveries(); return rows.every(d => d.attempts > 0) && rows })
  const handled = type => receiver.state.handled.filter(event => event.type === type)
  const alerts = () => h.mails.filter(mail => mail.subject === 'Outbound webhook delivery failed')
  const invite = async (name, role) => {
    const email = `dev001-${name}@example.test`
    const member = await api('access.give', owner, { email, name: `Webhook ${name}`, role })
    return { ...member, email, who: await h.signIn(email, { requested: true }) }
  }
  const choose = (who, on) => api('notification.preferences', who, { mentions: false, payment_mismatch: false, billrun_exceptions: false, proposals: false, webhook_failures: on })
  const developer = await invite('developer', 'developer'), finance = await invite('finance', 'finance'), quiet = await invite('quiet', 'finance'), accountant = await invite('accountant', 'accountant')
  await choose(finance.who, true); await choose(quiet.who, false); await choose(accountant.who, true)

  // Registering: the developer role administers endpoints; only HTTPS to a public host name.
  const hook = 'https://hooks.cedar.webhooks.test/webhooks/nectar'
  for (const url of ['http://hooks.example/x', 'https://10.0.0.8/x', 'https://localhost/x', 'https://billing.internal/x', 'https://user:pw@hooks.example/x', 'https://hooks.example:8443/x', 'not a url'])
    assert.equal((await api('webhook.create', developer.who, { url, events: ['*'] }, 400)).error, 'invalid_webhook_url', url)
  await api('webhook.create', finance.who, { url: hook, events: ['*'] }, 403)
  await api('webhook.create', developer.who, { url: hook, events: ['usage.threshold_crossed'] }, 400)
  const endpoint = await api('webhook.create', developer.who, { url: hook, events: ['*'], description: 'Cedar app' })
  assert.match(endpoint.secret, /^nwh_[\w-]{43}$/)
  await api('webhook.create', developer.who, { url: hook, events: ['*'] }, 409)
  receiver.state.secrets = [endpoint.secret]
  const view = await api('webhooks', accountant.who)
  assert.ok(!JSON.stringify(view).includes(endpoint.secret), 'a signing secret is shown once, when made')
  assert.equal(view.stripe_mapping.find(row => row.stripe === 'entitlements.active_entitlement_summary.updated').nectar, 'entitlements.updated')
  assert.ok(view.retry_minutes.reduce((sum, minutes) => sum + minutes, 0) >= 3 * 24 * 60, 'retries span at least three days')

  // Records annotated through the DEV-005 door; each event copies metadata as it stood.
  const annotate = async (kind, record, metadata) => api('metadata.write', owner, { kind, record, revision: (await api(`metadata/${kind}/${record}`)).revision, metadata })
  const product = (await api('product.create', owner, { code: 'dev001-platform', name: 'Webhook platform' })).id
  await api('feature.grant', owner, { product, feature: 'api_access' })
  const price = (await api('price.create', owner, { product, kind: 'flat', unit_amount: '100', taxable: false })).id
  const customer = (await api('customer.create', owner, { external_id: 'DEV001-CEDAR', name: 'Cedar Webhooks Ltd', billing_email: 'ap@cedar-webhooks.example' })).id
  await annotate('customer', customer, { app_account_id: 'acct_cedar_1' })
  const subscription = (await api('subscription.create', owner, { customer, start_date: '2026-07-01', price: [price] })).id
  await annotate('subscription', subscription, { app_account_id: 'acct_cedar_1', app_plan: 'growth' })
  await annotate('price', price, { app_plan: 'growth' })
  await waitFor('customer, subscription and entitlement events', () => handled('customer.created').length && handled('subscription.created').length && handled('entitlements.updated').length)
  const created = handled('customer.created')[0]
  assert.deepEqual(created.data.object, { id: customer, object: 'customer', external_id: 'DEV001-CEDAR', status: 'active', origin: 'native', language: 'en', billing_entity_id: null })
  assert.deepEqual(created.data.metadata, { customer: {} }, 'the customer had no metadata when it was created')
  assert.deepEqual(handled('subscription.created')[0].data.metadata, { customer: { app_account_id: 'acct_cedar_1' }, subscription: {} })
  assert.deepEqual(handled('entitlements.updated')[0].data.object.features, [{ feature: 'api_access', subscriptions: [subscription] }])
  assert.doesNotMatch(JSON.stringify(receiver.state.handled), /Cedar Webhooks Ltd|ap@cedar-webhooks/, 'payloads never carry names or email addresses')

  // The endpoint is down for an hour while July is billed and paid.
  receiver.state.down = true
  const run = await api('billrun.prepare', owner, { period: '2026-07' })
  const draft = (await api(`runs/${run.id}`)).invoices.find(invoice => invoice.customer_name === 'Cedar Webhooks Ltd')
  await api('invoice.approve', owner, { invoice: draft.id, acknowledge: true })
  await api('invoice.finalise', owner, { invoice: draft.id, issue_date: '2026-08-01' })
  await annotate('invoice', draft.id, { app_invoice_ref: 'inv_cedar_july' })
  const total = (await api(`invoices/${draft.id}`)).total_cents
  const payment = (await api('payment.record', owner, { customer, amount: (total / 100).toFixed(2), received_on: '2026-08-01', method: 'bank_transfer', reference: 'DEV001-WIRE-1' })).payment
  await annotate('payment', payment, { app_payment_ref: 'pay_cedar_1' })
  await api('payment.allocate', owner, { payment, invoice: draft.id, amount: (total / 100).toFixed(2) })
  const outage = (await attempted()).filter(d => d.status === 'pending')
  assert.deepEqual(['invoice.created', 'invoice.finalized', 'payment.recorded', 'invoice.paid'].filter(type => !outage.some(d => d.event_type === type)), [], 'the bill run and its payment are waiting')
  assert.ok(outage.every(d => d.last_outcome === 'http_error' && d.last_status === 503))

  // INT-003: one email for the outage, linked to the exact failed delivery, only to an opted-in member who can act.
  const [alert] = await waitFor('the outage email', async () => alerts().length && (await api('notifications', finance.who)).deliveries.some(d => d.event === 'webhook_failures' && d.status === 'accepted') && alerts())
  assert.equal(alerts().length, 1); assert.deepEqual([alert.to].flat(), [finance.email])
  const link = new URL(alert.html.match(/href="([^"]+)"/)[1].replaceAll('&amp;', '&'))
  const failedId = link.pathname.match(/^\/app\/webhooks\/deliveries\/(whd_[0-9a-f]{24})$/)[1]
  assert.ok(outage.some(d => d.id === failedId), 'the email names one exact failed delivery')
  assert.match(await h.page(link.pathname, finance.who), /Replay this event/)
  assert.equal((await h.raw(link.pathname)).status, 303, 'the link needs a signed-in member')
  const custody = (await api('notifications', finance.who)).deliveries.filter(d => d.event === 'webhook_failures')
  assert.deepEqual(custody.map(d => [d.href, d.status, d.provider_ref]), [[link.pathname, 'accepted', `test-${h.mails.indexOf(alert) + 1}`]])
  for (const member of [quiet, accountant]) assert.deepEqual((await api('notifications', member.who)).deliveries.filter(d => d.event === 'webhook_failures'), [])

  // invoice.paid copied the customer, subscription, invoice, price and payment metadata at payment time; later replacements never rewrite it.
  const paidDelivery = outage.find(d => d.event_type === 'invoice.paid')
  const paid = (await api(`webhooks/events/${paidDelivery.event_id}`)).payload
  assert.deepEqual(paid.data.metadata, { customer: { app_account_id: 'acct_cedar_1' }, subscription: { app_account_id: 'acct_cedar_1', app_plan: 'growth' }, invoice: { app_invoice_ref: 'inv_cedar_july' },
    prices: { [price]: { app_plan: 'growth' } }, payments: { [payment]: { app_payment_ref: 'pay_cedar_1' } }, credit_notes: {} })
  assert.equal(paid.data.object.amount_paid_cents, total); assert.equal(paid.data.object.amount_remaining_cents, 0)
  await annotate('customer', customer, { app_account_id: 'acct_cedar_2' })
  await annotate('subscription', subscription, {})
  await annotate('payment', payment, { app_payment_ref: 'changed' })
  assert.deepEqual((await api(`webhooks/events/${paidDelivery.event_id}`)).payload, paid, 'later annotations leave the event unchanged')

  // Retries during the hour fail; the first one after the endpoint returns delivers every event once.
  for (const minutes of [1, 6, 36]) await tick(T0 + minutes * MINUTE)
  assert.deepEqual([...new Set((await deliveries()).filter(d => d.status === 'pending').map(d => d.attempts))], [4])
  receiver.state.down = false
  await tick(T0 + 60 * MINUTE)
  assert.equal(handled('invoice.paid').length, 0, 'nothing is due until the next backoff step')
  await tick(T0 + 96 * MINUTE)
  const recovered = await deliveries()
  assert.ok(recovered.every(d => d.status === 'delivered'), 'every waiting event is delivered')
  for (const d of outage) assert.equal(recovered.find(row => row.id === d.id).attempts, 5)
  const arrivals = event => receiver.state.deliveries.filter(d => d.event === event).length
  for (const d of recovered) assert.equal(arrivals(d.event_id), 1, `${d.event_type} arrived once`)
  assert.deepEqual(handled('invoice.paid')[0], paid, 'the receiver got the stored event')
  assert.equal((await api('webhooks')).endpoints[0].failing, false)

  // Replay: the same stored bytes again; the receiving app handles the event once.
  await api('webhook.replay', accountant.who, { delivery: paidDelivery.id }, 403)
  const replay = await api('webhook.replay', finance.who, { delivery: paidDelivery.id })
  await waitFor('the replay', async () => (await api(`webhooks/deliveries/${replay.id}`)).status === 'delivered')
  const copies = receiver.state.deliveries.filter(d => d.event === paidDelivery.event_id)
  assert.equal(copies.length, 2); assert.equal(copies[1].body, copies[0].body, 'a replay posts the exact stored bytes')
  assert.equal(handled('invoice.paid').length, 1)
  assert.equal((await api(`webhooks/deliveries/${replay.id}`)).replay_of, paidDelivery.id)

  // Rotation: both secrets sign during the overlap window, then only the new one.
  const retired = endpoint.secret
  await api('webhook.rotate', finance.who, { endpoint: endpoint.id, overlap_hours: 24 }, 403)
  const rotated = await api('webhook.rotate', developer.who, { endpoint: endpoint.id, overlap_hours: 24 })
  assert.equal(rotated.previous_secrets_valid_until, new Date(T0 + 24 * 60 * MINUTE).toISOString())
  const record = reference => api('payment.record', owner, { customer, amount: '1.00', received_on: '2026-08-01', method: 'check', reference })
  const arrived = reference => waitFor(`payment ${reference}`, () => handled('payment.recorded').find(event => event.data.object.reference === reference))
  receiver.state.secrets = [rotated.secret]
  await record('DEV001-NEW-SECRET')
  const signedTwice = await arrived('DEV001-NEW-SECRET')
  assert.equal(receiver.state.deliveries.find(d => d.event === signedTwice.id).signatures, 2, 'both secrets sign during the overlap')
  receiver.state.secrets = [retired]
  await record('DEV001-OLD-SECRET')
  await arrived('DEV001-OLD-SECRET')
  await h.advanceClock(new Date(T0 + 25 * 60 * MINUTE).toISOString())
  const refused = receiver.state.refused
  await record('DEV001-AFTER-OVERLAP')
  await waitFor('the retired secret no longer verifies', () => receiver.state.refused > refused)
  const late = await waitFor('the refused delivery', async () => (await deliveries()).find(d => d.event_type === 'payment.recorded' && d.last_status === 400))
  receiver.state.secrets = [rotated.secret]
  await api('webhook.replay', developer.who, { delivery: late.id })
  const lateEvent = await arrived('DEV001-AFTER-OVERLAP')
  assert.equal(receiver.state.deliveries.find(d => d.event === lateEvent.id).signatures, 1, 'only the new secret signs after the overlap')

  // The receiving app refuses forged, altered, stale and unsigned deliveries.
  const genuine = receiver.state.deliveries.find(d => d.event === lateEvent.id).body
  const now = Math.floor(Date.now() / 1000)
  const sign = (secret, at, body = genuine) => `t=${at},v1=${createHmac('sha256', secret).update(`${at}.${body}`).digest('hex')}`
  const post = (signature, body = genuine) => fetch(receiver.url, { method: 'POST', headers: { 'content-type': 'application/json', ...(signature ? { 'nectar-signature': signature } : {}) }, body })
  assert.equal((await post(sign('synthetic-nectar-1', now))).status, 400, 'a forged signature')
  assert.equal((await post(sign(rotated.secret, now), genuine.replace('"amount_cents":100', '"amount_cents":1'))).status, 400, 'an altered body')
  assert.equal((await post(sign(rotated.secret, now - 3600))).status, 400, 'a stale timestamp')
  assert.equal((await post(null)).status, 400, 'an unsigned delivery')
  assert.equal((await post(sign(rotated.secret, now))).status, 204)
  assert.equal(handled('payment.recorded').filter(event => event.id === lateEvent.id).length, 1)

  // A product feature grant changes the customer's entitlements once.
  await api('feature.grant', owner, { product, feature: 'sso' })
  const changed = await waitFor('the entitlement change', () => handled('entitlements.updated')[1])
  assert.deepEqual(changed.data.object.features.map(f => f.feature), ['api_access', 'sso'])
  assert.deepEqual(changed.data.object.previous_features.map(f => f.feature), ['api_access'])

  // An endpoint that never recovers is retried on the backoff for more than three days, then left failed with one outage email.
  const dead = await api('webhook.create', developer.who, { url: 'https://dead.webhooks.test/hook', events: ['customer.updated'] })
  const current = await api(`customers/${customer}`)
  await api('customer.update', owner, { customer, revision: current.revision, name: current.name, billing_email: current.billing_email, language: 'es-US' })
  const T1 = T0 + 25 * 60 * MINUTE
  const doomed = await waitFor('the first failed attempt', async () => (await api(`webhooks/deliveries?endpoint=${dead.id}`)).find(d => d.attempts === 1))
  for (const minutes of [1, 6, 36, 96, 216, 456, 936, 1656, 2376, 3096, 3816, 4536]) await tick(T1 + minutes * MINUTE)
  const final = await api(`webhooks/deliveries/${doomed.id}`)
  assert.equal(final.status, 'failed'); assert.equal(final.attempts.length, 13)
  assert.ok(final.attempts.at(-1).at - final.attempts[0].at >= 3 * 24 * 60 * MINUTE, 'retried for at least three days')
  await tick(T1 + 10_000 * MINUTE)
  assert.equal((await api(`webhooks/deliveries/${doomed.id}`)).attempts.length, 13, 'a failed delivery waits for a person to replay it')
  assert.equal(alerts().filter(mail => mail.html.includes(`/app/webhooks/deliveries/${doomed.id}`)).length, 1, 'one email for the outage, not one per retry')

  // Screens: the developer manages endpoints and sees each secret once; readers see the log only.
  const screen = await h.page('/app/webhooks', developer.who)
  assert.ok(screen.includes(hook) && screen.includes('Register an endpoint') && !screen.includes(rotated.secret))
  const form = await h.raw('/app/webhooks/endpoint', { cookie: developer.who, form: new URLSearchParams([['url', 'https://forms.webhooks.test/webhooks/nectar'], ['events', 'invoice.paid'], ['description', 'Form endpoint']]) })
  assert.equal(form.status, 200)
  const shown = (await form.text()).match(/nwh_[\w-]{43}/)[0]
  assert.ok(!(await h.page('/app/webhooks', developer.who)).includes(shown), 'the form secret is shown once')
  assert.doesNotMatch(await h.page('/app/webhooks', accountant.who), /Register an endpoint|Rotate secret/)
  assert.match(await h.page(`/app/webhooks/deliveries/${paidDelivery.id}`, accountant.who), /invoice\.paid/)
  console.log('DEV-001 webhooks: outage retries, three-day backoff, signatures, replay, rotation, forged refusal, failure email and event-time metadata passed')
}
