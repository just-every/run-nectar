import assert from 'node:assert/strict'
import { applyPolicy } from './policy-helper.mjs'

export async function policyApprovals(h, owner) {
  const current = () => h.api('policies/current', owner)
  const before = await current()
  const request = (await h.api('credit.policy', owner, { two_person_above: '1000.00' })).request
  assert.deepEqual(await current(), before, 'preparing a policy never applies it')
  await h.api('policy.decide', owner, { request, decision: 'approved' }, 409)
  assert.deepEqual(await current(), before, 'a single owner must explicitly confirm in a second request')
  const single = await h.api('policy.decide', owner, { request, decision: 'approved', confirm_single: true })
  assert.equal(single.mode, 'single-approver')
  assert.equal((await current()).creditLimitCents, 100000)
  const saved = (await h.api('policies', owner)).find(r => r.id === request)
  assert.equal(saved.approval_mode, 'single-approver')
  const audit = (await h.api('audit', owner)).find(r => r.subject === request && r.action === 'policy.apply')
  assert.equal(JSON.parse(audit.detail).mode, 'single-approver')
  await h.api('policy.decide', owner, { request, decision: 'approved', confirm_single: true }, 409)

  await h.api('access.give', owner, { email: 'policy-finance@example.test', name: 'Policy Finance', role: 'finance' })
  await h.api('access.give', owner, { email: 'policy-accountant@example.test', name: 'Policy Accountant', role: 'accountant' })
  const finance = await h.signIn('policy-finance@example.test', { requested: true })
  const accountant = await h.signIn('policy-accountant@example.test', { requested: true })
  const agent = { bearer: (await h.api('credential.issue', owner, { name: 'Policy reader', scopes: ['prepare'] })).key }
  const oldBusiness = await h.api('business', owner)
  for (const [action, payload, kind] of [
    ['credit.policy', { two_person_above: '1200.00' }, 'credit'],
    ['certificate.policy', { enabled: true }, 'certificate'],
    ['tax.declare', { tax_jurisdiction: 'NY', tax_mode: 'flat_rate', tax_rate: '9', tax_note: 'Reviewed policy approval journey' }, 'tax'],
  ]) {
    for (const who of [finance, accountant, agent]) await h.api(action, who, payload, 403)
    const settings = await current(), business = await h.api('business', owner)
    const prepared = await h.api(action, owner, payload)
    const competing = await h.api(action, owner, payload)
    assert.deepEqual(await current(), settings)
    assert.deepEqual(await h.api('business', owner), business)
    for (const who of [accountant, agent]) await h.api('policy.decide', who, { request: prepared.request, decision: 'approved' }, 403)
    await h.api('policy.decide', owner, { request: prepared.request, decision: 'approved', confirm_single: true }, 409)
    assert.deepEqual(await current(), settings)
    await h.api('policy.decide', finance, { request: prepared.request, decision: 'approved', payload: { enabled: false, twoPersonAboveCents: 0 } })
    const decided = (await h.api('policies', owner)).find(r => r.id === prepared.request)
    assert.equal(decided.approval_mode, 'two-person')
    assert.equal(decided.decided_by, 'policy-finance@example.test')
    assert.deepEqual(decided.payload, prepared.payload, 'the decision uses the immutable saved values')
    if (kind === 'credit') assert.equal((await current()).creditLimitCents, 120000)
    if (kind === 'certificate') assert.equal((await current()).certificateRemindersEnabled, true)
    if (kind === 'tax') { const b = await h.api('business', owner); assert.equal(b.tax_jurisdiction, 'NY'); assert.equal(b.tax_rate, '9.00'); assert.equal(b.tax_reviewed_at, null) }
    await h.api('policy.decide', finance, { request: prepared.request, decision: 'approved' }, 409)
    await h.api('policy.decide', finance, { request: competing.request, decision: 'approved' }, 409)
    await h.api('policy.decide', owner, { request: competing.request, decision: 'rejected' })
  }
  // Restore the exact original billing policies for the other contract flows.
  await applyPolicy(h, owner, 'credit.policy', { two_person_above: '' })
  await applyPolicy(h, owner, 'certificate.policy', { enabled: false })
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: oldBusiness.tax_jurisdiction, tax_mode: oldBusiness.tax_mode, tax_rate: oldBusiness.tax_rate, tax_note: oldBusiness.tax_note })
  console.log('GOV-002 policy changes: exact owner preparation, separate active approver, explicit single-approver confirmation and history, stale/duplicate refusal passed')
}
