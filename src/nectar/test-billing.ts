// Isolated test invoices and test-account observations. These never enter the
// live invoice ledger, live collection scheduler or outbound-mail queue.
import type { Bindings } from '../auth.server'
import { actorLabel, type Actor } from './actor'
import { all, canonical, commit, guard, insist, newId, now, one, stmt, type Row } from './core'
import { localDate, zonedStart } from './dates'
import type { Input } from './input'
import { requireFreshFactor } from './mfa'
import { nextRetry } from './retry-policy'
import { requireSandbox, sandboxCatalog } from './test-mode'
import { sandboxProviderCustomer, sandboxStripe } from './test-stripe'

const memberFence = (env: Bindings, actor: Actor) => guard(env, 'forbidden', "EXISTS(SELECT 1 FROM nc_members WHERE id=? AND status='active' AND role IN ('owner','developer'))", actor.id)
const event = (env: Bindings, customer: string, key: string, at: number, kind: string, detail: unknown) =>
  stmt(env, 'INSERT INTO nc_sandbox_timeline(customer_id,event_key,at,kind,detail_json) VALUES(?,?,?,?,?)', customer, key, at, kind, canonical(detail))

export async function sandboxBillingView(env: Bindings, customer: string) {
  const authority = await one(env, 'SELECT account_ref,customer_ref,method_ref FROM nc_sandbox_processor_authority WHERE customer_id=?', customer)
  return { enabled: !!authority, processor: authority,
    invoices: (await all(env, 'SELECT * FROM nc_sandbox_invoices WHERE customer_id=? ORDER BY due_at,id', customer)).map((row): Row => ({ ...row, invoice: JSON.parse(row.invoice_json), invoice_json: undefined })),
    attempts: (await all(env, 'SELECT * FROM nc_sandbox_attempts WHERE customer_id=? ORDER BY due_at,invoice_id,attempt', customer)).map((row): Row => ({ ...row, result: JSON.parse(row.result_json), result_json: undefined })),
    timeline: (await all(env, 'SELECT * FROM nc_sandbox_timeline WHERE customer_id=? ORDER BY at,seq', customer)).map((row): Row => ({ ...row, detail: JSON.parse(row.detail_json), detail_json: undefined })) }
}

export async function bindSandboxProcessor(env: Bindings, actor: Actor, input: Input) {
  requireSandbox(actor)
  await requireFreshFactor(env, actor)
  input.only(['customer', 'stripe_customer_ref', 'confirm', 'returnTo'])
  insist(input.flag('confirm'), 'sandbox_confirmation_required')
  const c = await one(env, 'SELECT * FROM nc_sandbox_customers WHERE id=?', input.text('customer', { max: 100 }))
  insist(c, 'sandbox_customer_not_found', 404)
  const remote = input.text('stripe_customer_ref', { max: 255 })
  insist(!await one(env, 'SELECT 1 FROM nc_stripe_customer_bindings WHERE stripe_customer_ref=?', remote), 'sandbox_live_customer_refused', 409)
  const selected = await sandboxStripe(env), card = await sandboxProviderCustomer(selected, c.id, c.catalog_id, remote)
  const existing = await one(env, 'SELECT * FROM nc_sandbox_processor_authority WHERE customer_id=?', c.id)
  if (existing) {
    insist(existing.account_ref === selected.accountRef && existing.customer_ref === remote && existing.method_ref === card.methodId, 'sandbox_processor_binding_fixed', 409)
    return { id: c.id, enabled: true }
  }
  insist(!await one(env, 'SELECT 1 FROM nc_sandbox_invoices WHERE customer_id=?', c.id), 'sandbox_processor_binding_fixed', 409)
  await commit(env, [memberFence(env, actor),
    guard(env, 'sandbox_live_customer_refused', 'NOT EXISTS(SELECT 1 FROM nc_stripe_customer_bindings WHERE stripe_customer_ref=?)', remote),
    stmt(env, 'INSERT INTO nc_sandbox_processor_authority(customer_id,account_ref,customer_ref,method_ref,created_by,created_at) VALUES(?,?,?,?,?,?)', c.id, selected.accountRef, remote, card.methodId, actor.id, now()),
    event(env, c.id, 'billing-enabled', c.clock_at, c.trial_end && localDate(c.clock_at, (await sandboxCatalog(env, c.catalog_id)).configuration.timezone) < c.trial_end ? 'trialing' : 'active', { mode: 'sandbox', account: selected.accountRef }),
  ], { actor: actorLabel(actor), action: 'sandbox.processor.bind', subject: c.id, detail: { account: selected.accountRef, customer: remote } })
  return { id: c.id, enabled: true }
}

async function binding(env: Bindings, actor: Actor, customer: string) {
  requireSandbox(actor)
  const c = await one(env, 'SELECT * FROM nc_sandbox_customers WHERE id=?', customer)
  insist(c, 'sandbox_customer_not_found', 404)
  const authority = await one(env, 'SELECT * FROM nc_sandbox_processor_authority WHERE customer_id=?', customer)
  insist(authority, 'sandbox_processor_confirmation_required', 409)
  const selected = await sandboxStripe(env, authority.account_ref)
  const card = await sandboxProviderCustomer(selected, c.id, c.catalog_id, authority.customer_ref)
  insist(card.methodId === authority.method_ref && !await one(env, 'SELECT 1 FROM nc_stripe_customer_bindings WHERE stripe_customer_ref=?', authority.customer_ref), 'sandbox_processor_binding_changed', 409)
  return { c, authority, selected, catalog: await sandboxCatalog(env, c.catalog_id) }
}

function verifyIntent(intent: Row, origin: string, invoice: Row, authority: Row) {
  const amount = JSON.parse(invoice.invoice_json).rating.totalCents
  insist(intent.object === 'payment_intent' && intent.livemode === false && intent.customer === authority.customer_ref && intent.currency === 'usd'
    && intent.amount === amount && intent.metadata?.nectar_sandbox_attempt === origin && intent.metadata?.nectar_sandbox_invoice === invoice.id
    && (intent.payment_method === authority.method_ref || intent.status === 'requires_payment_method' && (intent.last_payment_error?.payment_method?.id ?? intent.last_payment_error?.payment_method) === authority.method_ref),
  'sandbox_processor_intent_mismatch', 409)
}

async function finishAttempt(env: Bindings, actor: Actor, attempt: Row, invoice: Row, authority: Row, intent: Row) {
  const origin = (await one(env, 'SELECT id FROM nc_sandbox_attempts WHERE invoice_id=? AND attempt=1', invoice.id))!.id
  verifyIntent(intent, origin, invoice, authority)
  const paid = intent.status === 'succeeded' && intent.amount_received === intent.amount
  const declined = intent.status === 'requires_payment_method' && intent.amount_received === 0 && intent.last_payment_error
  if (!paid && !declined) return false
  const code = declined ? String(intent.last_payment_error.decline_code ?? intent.last_payment_error.code) : null
  insist(!code || /^[a-z_]{1,100}$/.test(code), 'sandbox_processor_refusal_invalid', 409)
  const c = (await one(env, 'SELECT catalog_id FROM nc_sandbox_customers WHERE id=?', attempt.customer_id))!
  const catalog = await sandboxCatalog(env, c.catalog_id)
  const first = (await one(env, 'SELECT MIN(due_at) AS at FROM nc_sandbox_attempts WHERE invoice_id=?', invoice.id))!.at
  const next = paid ? null : nextRetry(code!, 'card', attempt.attempt, attempt.due_at, first,
    catalog.configuration.retry ?? { version: 'legacy-copy', maxAttempts: 8, windowDays: 14, scope: 'default' })
  const result = { mode: 'test', providerStatus: intent.status, declineCode: code, amountCents: intent.amount, receivedCents: intent.amount_received }
  await commit(env, [memberFence(env, actor),
    guard(env, 'sandbox_attempt_changed', "EXISTS(SELECT 1 FROM nc_sandbox_attempts WHERE id=? AND status IN ('claimed','unconfirmed'))", attempt.id),
    stmt(env, 'UPDATE nc_sandbox_attempts SET status=?,intent_ref=?,result_json=?,next_at=? WHERE id=?', paid ? 'paid' : 'declined', intent.id, canonical(result), next, attempt.id),
    stmt(env, 'UPDATE nc_sandbox_invoices SET status=? WHERE id=?', paid ? 'paid' : next ? 'open' : 'unpaid', invoice.id),
    event(env, attempt.customer_id, `${attempt.id}:outcome`, attempt.due_at, paid ? 'payment_succeeded' : 'payment_failed', { invoice: invoice.id, attempt: attempt.attempt, ...result }),
    event(env, attempt.customer_id, `${attempt.id}:state`, attempt.due_at, paid ? 'active' : next ? 'past_due' : 'unpaid', { invoice: invoice.id }),
    event(env, attempt.customer_id, `${attempt.id}:notice`, attempt.due_at, paid ? 'receipt_preview' : 'failure_notice_preview', { invoice: invoice.id, amountCents: intent.amount, delivered: false, boundary: 'Sandbox inbox only; no external message' }),
  ], { actor: actorLabel(actor), action: 'sandbox.payment.observe', subject: attempt.id, detail: result })
  return true
}

export async function executeSandboxBilling(env: Bindings, actor: Actor, customer: string) {
  const { c, authority, selected, catalog } = await binding(env, actor, customer)
  // An interrupted provider write is a read-only reconciliation job. Advancing
  // again never confirms it or creates another intent for that claim.
  if (await one(env, "SELECT 1 FROM nc_sandbox_attempts WHERE customer_id=? AND status IN ('claimed','unconfirmed')", customer)) return { status: 'unconfirmed' }
  const previews = (await all(env, 'SELECT preview_json FROM nc_sandbox_previews WHERE customer_id=? ORDER BY due_date,window_key', customer)).map(row => JSON.parse(row.preview_json))
  for (const p of previews) {
    if (await one(env, 'SELECT 1 FROM nc_sandbox_invoices WHERE customer_id=? AND window_key=?', customer, p.key)) continue
    insist(!p.rating.exceptions.length && p.rating.totalCents >= 0 && Number.isSafeInteger(p.rating.totalCents), 'sandbox_invoice_needs_review', 409)
    const id = `sandbox_invoice_${newId()}`, due = zonedStart(p.dueDate, catalog.configuration.timezone)
    await commit(env, [memberFence(env, actor), stmt(env, "INSERT INTO nc_sandbox_invoices(id,customer_id,window_key,due_at,invoice_json,status) VALUES(?,?,?,?,?,'open')", id, customer, p.key, due, canonical(p)),
      event(env, customer, `${id}:renewal`, due, previews.indexOf(p) === 0 ? 'active' : 'renewed', { invoice: id, period: p.period }),
      event(env, customer, `${id}:issue`, due, 'invoice_issued', { invoice: id, totalCents: p.rating.totalCents, period: p.period }),
    ], { actor: actorLabel(actor), action: 'sandbox.invoice.issue', subject: id, detail: { customer, totalCents: p.rating.totalCents } })
  }
  // Each explicit clock advance is bounded. Remaining due work stays visible
  // and can be continued by another explicit execution confirmation.
  for (let step = 0; step < 64; step++) {
    const invoices = await all(env, "SELECT * FROM nc_sandbox_invoices WHERE customer_id=? AND status='open' ORDER BY due_at,id", customer)
    const due: { invoice: Row; previous: Row | null; at: number }[] = []
    for (const invoice of invoices) {
      const previous = await one(env, 'SELECT * FROM nc_sandbox_attempts WHERE invoice_id=? ORDER BY attempt DESC LIMIT 1', invoice.id)
      const at = previous ? previous.next_at : invoice.due_at
      if (at !== null && at <= c.clock_at) due.push({ invoice, previous, at })
    }
    due.sort((a, b) => a.at - b.at || a.invoice.id.localeCompare(b.invoice.id))
    if (!due.length) return { status: 'complete' }
    const { invoice, previous, at } = due[0], amount = JSON.parse(invoice.invoice_json).rating.totalCents
    if (amount === 0) {
      await commit(env, [memberFence(env, actor), stmt(env, "UPDATE nc_sandbox_invoices SET status='paid' WHERE id=?", invoice.id),
        event(env, customer, `${invoice.id}:zero`, at, 'zero_invoice_complete', { invoice: invoice.id, amountCents: 0 })], { actor: actorLabel(actor), action: 'sandbox.invoice.complete', subject: invoice.id })
      continue
    }
    const attempt = { id: `sandbox_attempt_${newId()}`, invoice_id: invoice.id, customer_id: customer, attempt: (previous?.attempt ?? 0) + 1, due_at: at }
    await commit(env, [memberFence(env, actor),
      guard(env, 'sandbox_attempt_changed', 'NOT EXISTS(SELECT 1 FROM nc_sandbox_attempts WHERE invoice_id=? AND attempt=?)', invoice.id, attempt.attempt),
      guard(env, 'sandbox_processor_confirmation_required', 'EXISTS(SELECT 1 FROM nc_sandbox_processor_authority WHERE customer_id=? AND account_ref=? AND customer_ref=? AND method_ref=?)', customer, authority.account_ref, authority.customer_ref, authority.method_ref),
      stmt(env, "INSERT INTO nc_sandbox_attempts(id,invoice_id,customer_id,attempt,due_at,status,intent_ref) VALUES(?,?,?,?,?,'claimed',?)", attempt.id, invoice.id, customer, attempt.attempt, at, previous?.intent_ref ?? null),
    ], { actor: actorLabel(actor), action: 'sandbox.payment.claim', subject: attempt.id, detail: { invoice: invoice.id, attempt: attempt.attempt, amountCents: amount } })
    try {
      const intent = previous ? await selected.request(`/payment_intents/${encodeURIComponent(previous.intent_ref)}/confirm`,
        new URLSearchParams({ payment_method: authority.method_ref, off_session: 'true', error_on_requires_action: 'true' }), attempt.id)
        : await selected.request('/payment_intents', new URLSearchParams({ customer: authority.customer_ref, payment_method: authority.method_ref, amount: String(amount), currency: 'usd', confirm: 'true', off_session: 'true', 'payment_method_types[]': 'card',
          'metadata[nectar_sandbox_attempt]': attempt.id, 'metadata[nectar_sandbox_invoice]': invoice.id }), attempt.id)
      if (!await finishAttempt(env, actor, attempt, invoice, authority, intent)) {
        await stmt(env, "UPDATE nc_sandbox_attempts SET status='unconfirmed',intent_ref=? WHERE id=?", intent.id, attempt.id).run()
        return { status: 'unconfirmed' }
      }
    } catch {
      await stmt(env, "UPDATE nc_sandbox_attempts SET status='unconfirmed' WHERE id=? AND status='claimed'", attempt.id).run()
      return { status: 'unconfirmed' }
    }
  }
  return { status: 'more_due' }
}

export async function reconcileSandboxBilling(env: Bindings, actor: Actor, input: Input) {
  requireSandbox(actor)
  await requireFreshFactor(env, actor)
  input.only(['customer', 'confirm', 'returnTo'])
  insist(input.flag('confirm'), 'sandbox_confirmation_required')
  const customer = input.text('customer', { max: 100 }), { authority, selected } = await binding(env, actor, customer)
  for (const attempt of await all(env, "SELECT * FROM nc_sandbox_attempts WHERE customer_id=? AND status IN ('claimed','unconfirmed')", customer)) {
    const listed = attempt.intent_ref ? [await selected.request(`/payment_intents/${encodeURIComponent(attempt.intent_ref)}`)]
      : (await selected.request(`/payment_intents?${new URLSearchParams({ customer: authority.customer_ref, limit: '100' })}`)).data
    insist(Array.isArray(listed), 'sandbox_provider_unconfirmed', 409)
    const origin = (await one(env, 'SELECT id FROM nc_sandbox_attempts WHERE invoice_id=? AND attempt=1', attempt.invoice_id))!.id
    const found = listed.filter((intent: Row) => intent.metadata?.nectar_sandbox_attempt === origin && intent.metadata?.nectar_sandbox_invoice === attempt.invoice_id)
    if (!found.length) return { id: customer, status: 'unconfirmed' }
    insist(found.length === 1, 'sandbox_processor_intent_mismatch', 409)
    const invoice = (await one(env, 'SELECT * FROM nc_sandbox_invoices WHERE id=?', attempt.invoice_id))!
    if (!await finishAttempt(env, actor, attempt, invoice, authority, found[0])) return { id: customer, status: 'unconfirmed' }
  }
  return { id: customer, status: 'reconciled' }
}
