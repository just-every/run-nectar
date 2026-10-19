// Certificate controls extend the customer record using its existing form system.
import type { Actor } from '../actor'
import { can } from '../actor'
import { US_STATES } from '../business'
import type { Row } from '../core'
import { area, check, field, fileField, form, h, hidden, select, table } from './html'

export function certificateSection(c: Row, actor: Actor) {
  const back = `/app/customers/${c.id}`
  const states = US_STATES.map(value => ({ value, label: value }))
  return h`<section class="card" aria-labelledby="certificates"><h2 id="certificates">Exemption certificates</h2>
    <p class="hint">A finance approver reviews the document and attests its state, reference and validity. This is a recorded human review. State certificates must cover the whole service period; other states remain taxable.</p>
    ${c.exemptionClaims.length ? h`<p>Exemption requested in: ${c.exemptionClaims.map((x: Row) => x.state).join(', ')}.</p>` : h`<p>No state claims. Any reference-only exemption above uses the original tax policy.</p>`}
    ${table(['State', 'Certificate', 'Valid from', 'Expires', 'Review'], c.certificates.map((x: Row) => [x.state, h`<a href="/app/certificates/${x.id}">${x.reference}</a>`, x.valid_from, x.expires_on, x.status]), { empty: 'No certificates collected.' })}
    ${can(actor, 'approve') ? c.certificates.filter((x: Row) => x.status === 'pending').map((x: Row) => h`<h3>Review ${x.reference} (${x.state})</h3>${form('certificate.review', back, h`${hidden('certificate', x.id)}${select('Decision', 'decision', [{ value: 'validated', label: 'Validated: document and dates reviewed' }, { value: 'rejected', label: 'Rejected' }])}${area('Review basis', 'review_note', '', true, 2)}`, 'Record review', { secondary: true })}`) : ''}
    ${can(actor, 'records') ? h`<details><summary>Collect or renew a certificate</summary>${form('certificate.collect', back, h`${hidden('customer', c.id)}${select('Certificate state', 'state', states)}${field('Certificate reference', 'reference')}${field('Valid from', 'valid_from', { type: 'date' })}${field('Expires on (inclusive)', 'expires_on', { type: 'date' })}${fileField('Certificate document', 'file', { required: true, accept: '.pdf,.png,.jpg,.jpeg', hint: 'PDF, PNG or JPEG, at most 500 KB. Stored privately and reviewed before exemption applies.' })}`, 'Collect certificate', { multipart: true, layout: 'columns', secondary: true })}</details>
    <details><summary>Request an exemption before the document arrives</summary>${form('exemption.claim', back, h`${hidden('customer', c.id)}${select('Claim state', 'state', states)}`, 'Request exemption', { secondary: true })}</details>
    <p class="hint">A daily check requests missing or expired documents and reminds customers within 30 days of expiry. Mail status records provider acceptance; it does not prove mailbox delivery.</p>
    ${form('certificate.remind', back, '', 'Check certificate reminders now', { secondary: true })}` : ''}
    ${actor.role === 'owner' ? form('certificate.policy', '/app/settings#policy-changes', check('Enable certificate reminder mail for all customers', 'enabled', { checked: !!c.certificatePolicy?.enabled }), 'Prepare reminder policy', { secondary: true }) : ''}
    <p>Automatic reminder mail: ${c.certificatePolicy?.enabled ? 'enabled by the owner' : 'disabled; the owner can enable it here'}.</p>
    ${table(['State', 'Reminder', 'Mail status'], c.certificateReminders.map((x: Row) => [x.state, x.kind, x.status]), { empty: 'No certificate reminders yet.' })}
  </section>`
}
