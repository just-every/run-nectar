// GOV-007: required multi-factor sign-in through the public doors. The owner
// requires a second factor for finance operators, then installation-wide; a
// held member reaches no page, form post, JSON call or download until a TOTP
// factor is enrolled and presented; sensitive actions ask again after 15
// minutes; a reset ends every session; recovery codes work once; a copy
// without the sealing key puts members back at enrollment with the reason.
import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
function fromBase32(text) {
  const bytes = []; let bits = 0, value = 0
  for (const char of text) { value = (value << 5) | ALPHABET.indexOf(char); bits += 5; if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8 } }
  return Buffer.from(bytes)
}
/** An authenticator app: RFC 6238, SHA-1, six digits, 30-second steps. */
export function totp(secret, instant) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(instant / 30000)))
  const mac = createHmac('sha1', fromBase32(secret)).update(counter).digest(), offset = mac[19] & 15
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}
const wrong = code => String((Number(code) + 1) % 1_000_000).padStart(6, '0')

export async function mfaFlow(h, owner) {
  let clock = Date.now()
  const at = async ms => { clock = ms; await h.advanceClock(new Date(ms).toISOString()) }
  await at(clock)
  // An issued invoice to credit later, prepared before any requirement.
  const customer = (await h.api('customer.create', owner, { external_id: 'GOV007-CUST', name: 'Larch Analytics', billing_email: 'ap@larch.example' })).id
  const product = (await h.api('product.create', owner, { code: 'gov007-plan', name: 'Larch plan' })).id
  const price = (await h.api('price.create', owner, { product, kind: 'flat', unit_amount: '300', taxable: false })).id
  await h.api('subscription.create', owner, { customer, start_date: '2026-08-01', price: [price] })
  const run = (await h.api('billrun.prepare', owner, { period: '2026-08' })).id
  const invoice = (await h.api(`runs/${run}`, owner)).invoices.find(row => row.customer_id === customer)
  await h.api('invoice.approve', owner, { invoice: invoice.id, acknowledge: true })
  await h.api('invoice.finalise', owner, { invoice: invoice.id, issue_date: invoice.period_end })
  await h.api('access.give', owner, { email: 'gov007-finance@example.test', name: 'Farah Finance', role: 'finance' })
  await h.api('access.give', owner, { email: 'gov007-acct@example.test', name: 'Arlo Accountant', role: 'accountant' })
  const finance = await h.signIn('gov007-finance@example.test', { requested: true })
  const accountant = await h.signIn('gov007-acct@example.test', { requested: true })
  const agent = { bearer: (await h.api('credential.issue', owner, { name: 'GOV-007 agent', scopes: ['prepare', 'usage'] })).key }
  const members = Object.fromEntries((await h.api('members', owner)).map(m => [m.email, m.id]))

  // The owner requires a second factor for finance operators only.
  assert.deepEqual(await h.api('mfa.policy', owner, { scope: 'roles', roles: ['finance'] }), { scope: 'roles', roles: ['finance'] })
  await h.api('customers', accountant)
  await h.api('customers', owner)

  // Every door refuses the finance operator, signed in by email link, until a factor is enrolled.
  const held = async (who, code) => {
    const view = await h.raw('/app/customers', { cookie: who })
    assert.equal(view.status, 303, 'GOV-007 page refused'); assert.equal(view.headers.get('location'), '/app/security?returnTo=%2Fapp%2Fcustomers')
    const download = await h.raw('/app/exports/invoices.csv', { cookie: who })
    assert.equal(download.status, 303, 'GOV-007 download refused'); assert.doesNotMatch(await download.text(), /RB-|CD-/)
    const post = await h.raw('/app/do/customer.create', { cookie: who, form: new URLSearchParams({ external_id: 'GOV007-HELD', name: 'Held Co', billing_email: 'held@example.test', returnTo: '/app/customers' }) })
    assert.equal(post.status, 303, 'GOV-007 form post refused'); assert.equal(post.headers.get('location'), `/app/security?error=${code}`)
    assert.equal((await h.api('customers', who, undefined, 403)).error, code, 'GOV-007 JSON read refused')
    assert.equal((await h.api('customer.create', who, { external_id: 'GOV007-HELD', name: 'Held Co', billing_email: 'held@example.test' }, 403)).error, code, 'GOV-007 JSON write refused')
    assert.ok(!(await h.api('customers', owner, undefined, (await h.api('mfa', owner)).state ? 403 : 200))?.some?.(c => c.external_id === 'GOV007-HELD'), 'GOV-007 nothing was written while held')
  }
  await held(finance, 'mfa_enrollment_required')
  assert.match(await h.page('/app/security', finance), /Enroll an authenticator app or a passkey/)
  const started = await h.api('mfa.totp.start', finance, { label: 'Farah phone' })
  assert.match(started.uri, /^otpauth:\/\/totp\/.*secret=[A-Z2-7]+.*period=30/)
  assert.equal((await h.api('mfa.totp.confirm', finance, { factor: started.factor, code: wrong(totp(started.secret, clock)) }, 403)).error, 'mfa_code_invalid')
  const enrolled = await h.api('mfa.totp.confirm', finance, { factor: started.factor, code: totp(started.secret, clock) })
  assert.equal(enrolled.recovery_codes.length, 10, 'GOV-007 one-time recovery codes are issued')
  assert.ok(Array.isArray(await h.api('customers', finance)), 'GOV-007 enrolling and presenting a code opens the doors')
  assert.equal((await h.raw('/app/exports/invoices.csv', { cookie: finance })).status, 200)

  // Twenty minutes later a credit asks for a fresh code and refuses a wrong one.
  await at(clock + 20 * 60 * 1000)
  const credit = { invoice: invoice.id, amount: '25.00', reason: 'GOV-007 service credit' }
  assert.equal((await h.api('credit.issue', finance, credit, 403)).error, 'mfa_step_up_required', 'GOV-007 step-up after 15 minutes')
  assert.equal((await h.api('mfa.verify', finance, { code: wrong(totp(started.secret, clock)) }, 403)).error, 'mfa_code_invalid')
  assert.equal((await h.api('credit.issue', finance, credit, 403)).error, 'mfa_step_up_required', 'GOV-007 a wrong code does not satisfy the step-up')
  assert.equal((await h.api(`invoices/${invoice.id}`, finance)).creditedCents, 0, "GOV-007 nothing was credited without the fresh code")
  assert.equal((await h.api('mfa.verify', finance, { code: totp(started.secret, clock) })).step_up, true)
  assert.equal((await h.api('mfa.verify', finance, { code: totp(started.secret, clock) }, 403)).error, 'mfa_code_invalid', 'GOV-007 a used code is not accepted twice')
  assert.ok((await h.api('credit.issue', finance, credit)).credit, 'GOV-007 a fresh code lets the credit through')

  // Agent and application credentials can never perform these actions.
  for (const [action, body] of [['credit.issue', credit], ['access.give', { email: 'x@example.test', name: 'X', role: 'finance' }], ['credential.issue', { name: 'X', scopes: ['prepare'] }], ['subscription.adopt', { subscription: 'none' }], ['mfa.verify', { code: '123456' }], ['mfa.reset', { member: members['gov007-finance@example.test'] }]])
    assert.equal((await h.api(action, agent, body, 403)).error.match(/person_required|owner_required|forbidden/)?.[0] !== undefined, true, `GOV-007 agent refused ${action}`)

  // A new session is held at the check; a recovery code works exactly once.
  const second = await h.signIn('gov007-finance@example.test')
  await held(second, 'mfa_required')
  await h.api('mfa.verify', second, { code: enrolled.recovery_codes[0] })
  await h.api('customers', second)
  const third = await h.signIn('gov007-finance@example.test')
  assert.equal((await h.api('mfa.verify', third, { code: enrolled.recovery_codes[0] }, 403)).error, 'mfa_code_invalid', 'GOV-007 recovery codes are one-time')

  // Installation-wide: the accountant and the owner are held the same way.
  await h.api('mfa.policy', owner, { scope: 'all' })
  await held(accountant, 'mfa_enrollment_required')
  assert.equal((await h.api('customers', owner, undefined, 403)).error, 'mfa_enrollment_required')
  const enroll = async who => { const s = await h.api('mfa.totp.start', who, {}); await h.api('mfa.totp.confirm', who, { factor: s.factor, code: totp(s.secret, clock) }); return s.secret }
  const ownerSecret = await enroll(owner)
  const accountantSecret = await enroll(accountant)
  await h.api('invoices', accountant)

  // Resetting the finance operator's factor ends every open session at once.
  const reset = await h.api('mfa.reset', owner, { member: members['gov007-finance@example.test'] })
  assert.equal(reset.factors_removed, 1); assert.ok(reset.sessions_ended >= 3, JSON.stringify(reset))
  for (const who of [finance, second, third]) await h.api('me', who, undefined, 401)
  const after = await h.signIn('gov007-finance@example.test')
  assert.equal((await h.api('customers', after, undefined, 403)).error, 'mfa_enrollment_required', 'GOV-007 a reset member enrolls again')

  // Twenty more minutes: the owner's access change asks again too.
  await at(clock + 20 * 60 * 1000)
  assert.equal((await h.api('access.give', owner, { email: 'gov007-late@example.test', name: 'Late', role: 'accountant' }, 403)).error, 'mfa_step_up_required')
  await h.api('mfa.verify', owner, { code: totp(ownerSecret, clock) })
  await h.api('access.give', owner, { email: 'gov007-late@example.test', name: 'Late', role: 'accountant' })

  // A copy without the MFA key (a restore without it) puts members back at enrollment with the reason shown.
  const key = h.vars.MFA_KEY
  h.vars.MFA_KEY = randomBytes(32).toString('base64url'); await at(clock + 60 * 1000)
  const changed = await h.api('customers', accountant, undefined, 403)
  assert.deepEqual([changed.error, changed.detail.reason], ['mfa_enrollment_required', 'mfa_key_changed'])
  assert.match(await h.page('/app/security', accountant), /MFA key this copy does not hold/)
  delete h.vars.MFA_KEY; await at(clock + 60 * 1000)
  assert.equal((await h.api('mfa', accountant)).reason, 'mfa_key_missing')
  assert.match(await h.page('/app/security', accountant), /this copy has no MFA key/)
  assert.equal((await h.api('mfa.totp.start', accountant, {}, 409)).error, 'mfa_key_missing')
  h.vars.MFA_KEY = key; await at(clock + 60 * 1000)
  const back = await h.signIn('gov007-acct@example.test')
  await h.api('mfa.verify', back, { code: totp(accountantSecret, clock) })
  await h.api('invoices', back) // GOV-007 sealed values open again under the same key

  // The audit trail lists each step.
  const trail = (await h.api('audit', owner)).filter(row => row.action.startsWith('mfa.'))
  const steps = new Set(trail.map(row => row.action))
  for (const action of ['mfa.policy', 'mfa.enroll', 'mfa.refused', 'mfa.verify', 'mfa.step_up', 'mfa.reset']) assert.ok(steps.has(action), `GOV-007 audit lists ${action}`)
  assert.ok(trail.some(row => row.action === 'mfa.reset' && row.subject === members['gov007-finance@example.test']))
  assert.match(await h.page('/app/audit', owner), /mfa reset/)
  console.log('GOV-007 required multi-factor sign-in passed')
}
