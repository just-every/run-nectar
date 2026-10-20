import type { Bindings } from '../../auth.server'
import type { Actor } from '../actor'
import { parseJson, type Row } from '../core'
import { customers } from '../customers'
import { erasureRequests } from '../erasure-requests'
import { area, check, field, fileField, form, h, hidden, page, select, table, tag } from './html'

const back = '/app/erasures'

function date(value: unknown) {
  if (value === null || value === undefined || value === '') return 'Not recorded'
  if(/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return new Intl.DateTimeFormat('en-US',{timeZone:'UTC',dateStyle:'medium'}).format(new Date(String(value)+'T00:00:00Z'))+' (business local date)'
  const instant = typeof value === 'number' ? value : /^\d+$/.test(String(value)) ? Number(value) : Date.parse(String(value))
  if (!Number.isFinite(instant) || !Number.isFinite(new Date(instant).getTime())) return 'Not recorded'
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }).format(instant) + ' UTC'
}

// Keep evidence names, identifiers and field paths readable at phone width.
const wrapped = (value: unknown) => h`${String(value ?? '').match(/.{1,16}/gu)?.map(part => h`${part}<wbr>`) ?? ''}`
const label = (key: string) => key.replace(/[_-]/g, ' ')

function receiptRows(value: unknown, path = ''): unknown[][] {
  if (Array.isArray(value)) return value.flatMap((item, index) => receiptRows(item, `${path} ${index + 1}`.trim()))
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => receiptRows(item, path ? `${path} · ${label(key)}` : label(key)))
  return [[wrapped(path), wrapped(typeof value === 'boolean' ? value ? 'Yes' : 'No' : value ?? 'Not recorded')]]
}

export async function erasurePage(env: Bindings, actor: Actor, url: URL) {
  // Resolve request authority first; agent credentials cannot open this page.
  const requests = await erasureRequests(env, actor)
  const people = await customers(env, actor)
  const owner = actor.kind === 'member' && actor.role === 'owner'
  const canRequest = actor.kind === 'member' && ['owner', 'finance'].includes(actor.role ?? '')
  const customerName = (id: string) => people.find(customer => customer.id === id)?.name || 'Erased customer'

  return page('Privacy erasure', actor, h`<h1>Privacy erasure</h1>
    <p>Verify each request before erasing personal information. Confirmation goes to the billing email on file. Only the owner can approve erasure or record another verification method.</p>
    <section class="card"><h2>Record a request</h2>
      ${canRequest ? form('erasure.request', back, h`${select('Customer', 'customer', people.map(customer => ({ value: customer.id, label: customer.name })), '', { blank: 'Choose a customer' })}${field('Unverified requester email (optional)','claimed_email',{type:'email',required:false,hint:'Recorded as a claim only. Verification always goes to the billing email on file.'})}`, 'Send verification email') : h`<p>Your role can read requests and receipts.</p>`}
      <p class="hint">The confirmation link expires after seven days and can be used once. Provider acceptance does not confirm mailbox delivery.</p>
    </section>
    <section class="card"><h2>Requests and receipts</h2>
      ${requests.length ? requests.map((request: Row) => {
        const receipt = parseJson<unknown>(request.receipt_json, null)
        return h`<article><h3>${customerName(request.customer_id)}</h3>
          <p>${tag(request.status)}</p>
          ${table(['Detail', 'Value'], [
            ['Request', wrapped(request.id)],
            ...(request.claimed_email ? [['Unverified requester',request.claimed_email]] : []),
            ['Verification mail', request.mail_status || 'Not recorded'],
            ['Confirmation expires', date(request.expires_at)],
            ['Verification method', request.verified_method ? label(request.verified_method) : 'Awaiting verification'],
            ...(request.verification_reason ? [['Alternative verification reason', request.verification_reason]] : []),
            ...(request.evidence_name ? [['Evidence file', wrapped(request.evidence_name)]] : []),
            ...(request.evidence_sha256 ? [['Evidence SHA-256', wrapped(request.evidence_sha256)]] : []),
            ...(request.retain_until ? [['Financial retention until', date(request.retain_until)]] : []),
          ])}
          ${request.status !== 'complete' && request.evidence_sha256 && owner ? h`<p><a href="/app/erasures/${request.id}/evidence">Download private verification evidence</a></p>` : ''}
          ${owner && request.status === 'pending' ? h`<details><summary>Verify by another method</summary>
            <p>Use this when the billing email is unreachable or disputed. Record the method and reason, and attach its evidence. Both are recorded on the erasure receipt.</p>
            ${form('erasure.verify', back, h`${hidden('request', request.id)}${area('Verification method and reason', 'reason')}${fileField('Verification evidence', 'evidence', { required: true, hint: 'Attach the evidence supporting this verification, up to 256,000 bytes.' })}`, 'Record alternative verification', { multipart: true, secondary: true })}
          </details>` : ''}
          ${owner && request.status === 'verified' ? form('erasure.approve', back, h`${hidden('request', request.id)}${check('I approve erasing this customer’s personal information and retaining the required financial records.', 'confirm')}`, 'Approve erasure') : ''}
          ${request.status === 'pending' ? h`<p>Awaiting billing-email confirmation or documented owner verification.</p>` : request.status === 'verified' ? h`<p>Verified. Awaiting owner approval.</p>` : ''}
          ${receipt ? h`<details><summary>Erasure receipt</summary>${table(['Record or field', 'Change or retained detail'], receiptRows(receipt))}</details>` : ''}
        </article>`
      }) : h`<p>No erasure requests recorded.</p>`}
    </section>
    <section class="card"><h2>Financial retention</h2>
      <p>Required legal names, amounts, dates and tax records remain for seven years from the latest issue or payment date. Personal information outside that financial custody is erased or anonymized. For moved-in records whose issue/payment dates are unavailable, the receipt uses approval’s business-local date as a conservative anchor. Removal of expired financial records produces a receipt.</p>
      ${owner ? form('erasure.purge', back, '', 'Remove expired retained documents', { secondary: true }) : ''}
    </section>`, { url, current: '/app/customers' })
}
