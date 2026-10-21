import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { file } from './harness.mjs'
import { stripeHistoryCapture } from '../fixtures/stripe-history.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')

// MOVE-007 / NEC-15 / GOV-005: original custody through the real Worker's
// upload, attachment, authority, audit and customer-erasure HTTP doors.
export async function importOriginalsFlow(h, owner) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  await h.advanceClock('2026-07-01T16:00:00Z')
  const capture = stripeHistoryCapture()
  capture.customers.data[0].metadata = { opaque: '<script>synthetic-nectar-untrusted-original</script>', unicode: 'Synthetic café' }
  const email = capture.customers.data[0].email
  const originals = Object.entries(capture).map(([kind, value]) => {
    // A personal filename deliberately exercises whole-job retirement under
    // the existing import kit's privacy contract, rather than a DB shortcut.
    const name = kind === 'customers' ? email : `${kind}.json`
    const bytes = Buffer.from(`\n${JSON.stringify(value, null, 2)}\n `)
    const sha256 = digest(bytes)
    const key = JSON.stringify([name, sha256])
    const id = digest(JSON.stringify(['artifact', key]))
    return { kind, name, bytes, sha256, id }
  })
  const files = Object.fromEntries(originals.map(original => [original.kind, file(original.name, original.bytes, 'application/json')]))
  const preview = await api('import.preview', files)
  assert.deepEqual(preview.rejected, [])
  const job = (await api('import.apply', { ...files, fingerprint: preview.fingerprint })).job
  const path = original => `/app/import/${job}/originals/${original.id}`
  const downloads = async () => (await api('audit')).filter(row => row.action === 'import.original.download' && row.subject === job)
  const initialAudit = (await downloads()).length
  for (const original of originals) {
    const response = await h.raw(path(original), { cookie: owner })
    assert.equal(response.status, 200, `The owner can download the retained ${original.kind} file`)
    assert.equal(response.headers.get('content-type'), 'application/octet-stream')
    assert.match(response.headers.get('content-disposition'), /^attachment; filename="import-original-[a-f0-9]{64}\.bin"$/)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.match(response.headers.get('content-security-policy'), /sandbox/)
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.deepEqual(bytes, original.bytes, 'Whitespace, UTF-8 and original provider fields survive byte for byte')
    assert.equal(digest(bytes), original.sha256)
    assert.equal(response.headers.get('content-digest'), `sha-256=:${Buffer.from(original.sha256, 'hex').toString('base64')}:`)
  }
  const audit = await downloads()
  const ownerEmail = (await api('me')).email
  assert.equal(audit.length - initialAudit, originals.length, 'Each successful file download has one durable audit entry')
  for (const original of originals) {
    const entry = audit.find(row => JSON.parse(row.detail).file === original.id)
    assert.ok(entry)
    assert.equal(entry.actor, ownerEmail)
    assert.deepEqual(JSON.parse(entry.detail), { file: original.id, sha256: original.sha256, size: original.bytes.length })
  }

  const custom = await api('role.define', { name: 'Synthetic custody reader', capabilities: ['read.customers', 'read.invoices', 'read.payments', 'read.reports', 'export', 'propose'] })
  const selected = originals.find(original => original.kind === 'customers')
  for (const role of ['finance', 'accountant', 'developer', 'collections', 'support', 'sales', 'custom']) {
    const email = `synthetic-nectar-custody-${role}@example.test`
    await api('access.give', { email, name: `Synthetic custody ${role}`, role, ...(role === 'custom' ? { custom_role: custom.id } : {}) })
    const cookie = await h.signIn(email, { requested: true })
    const response = await h.raw(path(selected), { cookie })
    assert.equal(response.status, 403, `${role} cannot download originals despite ordinary typed-record access`)
    assert.equal(response.headers.get('content-disposition'), null)
    assert.ok(!(await response.text()).includes('synthetic-nectar-untrusted-original'))
  }
  for (const scope of ['prepare', 'usage']) {
    const credential = await api('credential.issue', { name: `Synthetic custody ${scope}`, scopes: [scope] })
    const response = await h.raw(path(selected), { bearer: credential.key })
    assert.equal(response.status, 403, 'Agent credentials never receive retained originals')
    assert.equal(response.headers.get('content-disposition'), null)
    await response.text()
  }
  const anonymous = await h.raw(path(selected))
  assert.equal(anonymous.status, 303, 'A signed-out download uses the established app sign-in gate')
  assert.match(anonymous.headers.get('location'), /\/signin\?returnTo=/)
  assert.equal(anonymous.headers.get('content-disposition'), null)
  assert.equal(await anonymous.text(), '')
  const unknown = await h.raw(`/app/import/${job}/originals/${'0'.repeat(64)}`, { cookie: owner })
  assert.equal(unknown.status, 404)
  await unknown.text()
  assert.equal((await downloads()).length, audit.length, 'Refused requests do not masquerade as completed downloads')

  const customer = (await api('customers')).find(row => row.external_id === capture.customers.data[0].id).id
  const request = await api('erasure.request', { customer })
  await api('erasure.verify', { request: request.id, reason: 'Synthetic identity verified independently', evidence: file('synthetic-verification.txt', 'Synthetic verified identity') })
  const erased = await api('erasure.approve', { request: request.id, confirm: true })
  assert.ok(erased.receipt.importCustody.jobsRetired >= 1, 'A personal source filename retires the import through real privacy custody')
  for (const original of originals) {
    const response = await h.raw(path(original), { cookie: owner })
    assert.equal(response.status, 410, 'Even the owner cannot revive an erased import original')
    assert.equal(response.headers.get('content-disposition'), null)
    assert.ok(!(await response.text()).includes('synthetic-nectar-untrusted-original'))
  }
  assert.equal((await downloads()).length, audit.length, 'Retired-original refusals issue neither bytes nor successful-download receipts')
  console.log('MOVE-007 owner-only exact opaque originals, per-file digests and atomic audit, every nonowner/agent refusal and erasure retirement passed')
}
