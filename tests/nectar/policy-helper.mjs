import assert from 'node:assert/strict'

const sessions = new WeakMap()

// Exercise both real policy modes through HTTP; existing clause journeys now
// explicitly confirm policy changes instead of relying on an immediate write.
export async function applyPolicy(h, owner, action, payload) {
  const prepared = await h.api(action, owner, payload)
  assert.equal(prepared.status, 'pending')
  const saved = (await h.api('policies', owner)).find(r => r.id === prepared.request)
  const approver = await reviewer(h, owner, saved.singleAllowed)
  return await h.api('policy.decide', approver, { request: prepared.request, decision: 'approved', confirm_single: saved.singleAllowed })
}

export async function reviewer(h, owner, singleAllowed) {
  let approver = owner
  if (!singleAllowed) {
    const me = await h.api('me', owner)
    const member = (await h.api('members', owner)).find(m => m.id !== me.id && m.status === 'active' && ['owner', 'finance'].includes(m.role))
    assert.ok(member, 'a separate authorized person exists')
    if (!sessions.has(h)) sessions.set(h, new Map())
    const savedSessions = sessions.get(h)
    if (!savedSessions.has(member.id)) savedSessions.set(member.id, await h.signIn(member.email))
    approver = savedSessions.get(member.id)
  }
  return approver
}
