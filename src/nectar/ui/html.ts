// Page frame and small form helpers. Every value is escaped; pages need no script.
import branding from '../../branding.json'
import { can, canRead, roleName, type Actor } from '../actor'
import { formatInstant } from '../dates'
import { money } from '../decimal'
import { icon, type IconName } from './icons'
import { personName, shellOf } from './shell'

export const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!))

export type Html = { html: string }
export const raw = (html: string): Html => ({ html })
export function h(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0]
  values.forEach((value, index) => { out += render(value) + strings[index + 1] })
  return { html: out }
}

// An email address in running text may wrap only after its "@" or before a ".",
// never mid-word: <wbr> marks those points, and a hyphen stays joined to its neighbours.
const ADDRESS = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[A-Za-z]{2,}/g
export function addresses(text: unknown): Html {
  const value = String(text ?? '')
  let out = '', last = 0
  for (const found of value.matchAll(ADDRESS)) {
    out += esc(value.slice(last, found.index)) + esc(found[0]).replace(/\w(?:-+\w)+/g, joined => `<span class="joined">${joined}</span>`).replace('@', '@<wbr>').replace(/\./g, '<wbr>.')
    last = found.index! + found[0].length
  }
  return raw(out + esc(value.slice(last)))
}

/** Who did something, by name; an address only when the person has no name on record. */
export const who = (actor: Actor, label: unknown) => addresses(personName(actor, label))

function render(value: unknown): string {
  if (value === null || value === undefined || value === false) return ''
  if (Array.isArray(value)) return value.map(render).join('')
  if (typeof value === 'object' && 'html' in (value as Html)) return (value as Html).html
  return esc(value)
}

// The sidebar: the five work destinations, then the rest of the product
// (also listed with what each does on More), then the business settings.
// Each destination shows only to a role that can open it (GOV-001).
export const NAV: { href: string; label: string; icon: IconName; show: (actor: Actor) => boolean }[] = [
  { href: '/app', label: 'Home', icon: 'home', show: () => true },
  { href: '/app/receivables', label: 'Receivables', icon: 'receivables', show: actor => canRead(actor, 'invoices') && canRead(actor, 'payments') && canRead(actor, 'customers') },
  { href: '/app/customers', label: 'Customers', icon: 'customers', show: actor => canRead(actor, 'customers') },
  { href: '/app/usage', label: 'Usage', icon: 'usage', show: actor => can(actor, 'read') },
  { href: '/app/billing', label: 'Billing', icon: 'billing', show: actor => can(actor, 'read') },
]
export const MORE: { href: string; label: string; about: string; icon: IconName; show: (actor: Actor) => boolean }[] = [
  { href: '/app/erasures', label: 'Privacy erasure', icon: 'customers', about: 'Verify requests, erase personal data and review financial retention receipts.', show: actor => actor.kind === 'member' && can(actor, 'read') },
  { href: '/app/cadences', label: 'Collections cadences', icon: 'receivables', about: 'Transfer reminders, promise holds, disputed amounts and owner escalation.', show: actor => can(actor, 'read') || can(actor, 'receivables') },
  { href: '/app/answers', label: 'Billing answers', icon: 'sparkle', about: 'Ask about saved invoice calculations, source events and billing terms.', show: actor => canRead(actor, 'customers') && canRead(actor, 'invoices') },
  { href: '/app/catalog', label: 'Catalog', icon: 'catalog', about: 'Products, versioned prices, meters and the features each product grants.', show: actor => canRead(actor, 'catalog') },
  { href: '/app/reports/billings', label: 'Reports', icon: 'exports', about: 'Billings, collections, receivables, credits, tax and unbilled usage, each figure drilled to its source.', show: actor => !can(actor, 'read') && canRead(actor, 'reports') },
  { href: '/app/proposals', label: 'Proposals', icon: 'proposals', about: 'Work an agent or a colleague prepared for your approval.', show: actor => can(actor, 'read') },
  { href: '/app/numbering', label: 'Number register', icon: 'billing', about: 'Captured and issued invoice numbers, credit notes, gaps and invoice series.', show: actor => canRead(actor, 'invoices') },
  { href: '/app/import', label: 'Move in', icon: 'movein', about: 'Bring Stripe Billing records in, compare in shadow, then cut over.', show: actor => can(actor, 'records') },
  { href: '/app/exports', label: 'Exports', icon: 'exports', about: 'Invoices, usage, subscriptions and bill runs to keep or hand to your accountant.', show: actor => can(actor, 'export') },
  { href: '/app/audit', label: 'Audit trail', icon: 'audit', about: 'Every change, approval and issue, with who made it.', show: actor => can(actor, 'export') && can(actor, 'read') },
  { href: '/app/settings', label: 'Business and tax', icon: 'settings', about: 'Billing identity, timezone, invoice numbering and the declared tax policy.', show: actor => can(actor, 'read') },
  { href: '/app/security', label: 'Sign-in security', icon: 'access', about: 'Your authenticator app, passkeys and recovery codes.', show: actor => actor.kind === 'member' },
  { href: '/app/access', label: 'Access', icon: 'access', about: 'Who can sign in, their roles, and agent credentials.', show: actor => actor.kind === 'member' && can(actor, 'credentials') },
]

const headers = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'strict-origin',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow',
  'content-security-policy': "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
}

const initials = (name: string) => name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(word => word[0]!.toUpperCase()).join('')
const ago = (ms: number, zone: string) => {
  const minutes = Math.max(1, Math.round((Date.now() - ms) / 60000))
  return minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.round(minutes / 60)} hr ago` : `on ${new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'short', day: 'numeric' }).format(new Date(ms))}`
}
const clock = (zone: string) => {
  const at = new Date()
  const day = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(at).replace(/^(\w+),/, '$1')
  return h`<span>${day}</span> <span>${new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(at)}</span>`
}

export function page(title: string, actor: Actor | null, body: Html, { current = '', url, status = 200, showNav = true, lang = 'en', script = '' }: { current?: string; url?: URL; status?: number; showNav?: boolean; lang?: string; script?: string } = {}): Response {
  const notice = url?.searchParams.get('notice'), error = url?.searchParams.get('error')
  const shell = shellOf(actor)
  const link = (item: { href: string; label: string; icon: IconName }, count = 0) => h`<li><a href="${item.href}"${item.href === current ? raw(' aria-current="page"') : ''}>${icon(item.icon)}<span>${item.label}</span>${count ? h`<span class="count-pill" aria-label="${count} waiting">${count}</span>` : ''}</a></li>`
  const nav = actor && showNav ? h`<nav aria-label="Main"><ul>${NAV.filter(item => item.show(actor)).map(item => link(item))}</ul><ul>${MORE.filter(item => item.show(actor)).map(item => link(item, item.href === '/app/proposals' ? shell?.pending ?? 0 : 0))}</ul></nav>` : ''
  const role = roleName(actor)
  const name = actor && (!actor.name.trim() || actor.name.trim() === role) && actor.email ? actor.email : actor?.name ?? ''
  const who = actor ? h`<div class="side-foot"><p class="who"><span class="avatar" aria-hidden="true">${initials(name)}</span><span class="who-lines"><span class="who-name">${addresses(name)}</span>${role ? h`<span class="role">${role}</span>` : ''}${shell ? h`<span>${shell.legalName}</span>${shell.place ? h`<span>${shell.place}</span>` : ''}` : ''}</span></p>
    ${shell && nav ? h`<p class="synced">${icon('synced')}<span>${shell.lastUsage ? h`Usage imported<br>${ago(shell.lastUsage, shell.timezone)}` : h`No usage imported yet`}</span></p>` : ''}</div>` : ''
  const top = actor && shell && nav ? h`<header class="top"><p class="top-place">${shell.legalName}<span>Billing in ${new Intl.DateTimeFormat('en-US', { timeZone: shell.timezone, timeZoneName: 'longGeneric' }).formatToParts(new Date()).find(part => part.type === 'timeZoneName')?.value ?? shell.timezone}</span></p><p class="top-time">${clock(shell.timezone)}</p>${can(actor, 'records') ? h`<a class="button top-action" href="/app/billing#prepare">Prepare a bill run</a>` : ''}</header>` : ''
  const menu = nav ? h`<label class="menu-button" for="menu">${icon('menu')}<span>Menu</span></label>` : ''
  const search = actor && nav && canRead(actor, 'customers') ? h`<section class="card"><form role="search" aria-label="Customer lookup" method="get" action="/app/customers" class="row-form">${field('Find a customer', 'search', { required: false, value: url?.pathname === '/app/customers' ? url.searchParams.get('search') ?? '' : '', hint: 'Name, email, customer ID, invoice or credit number, payment reference or metadata.' })}<button class="secondary" type="submit">Search</button></form></section>` : ''
  const document = h`<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · ${branding.name}</title><link rel="icon" href="/favicon.ico" sizes="any"><link rel="icon" href="/brand/favicon-32.svg" type="image/svg+xml"><link rel="preload" href="/fonts/hanken-grotesk/hanken-grotesk-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin="anonymous"><link rel="stylesheet" href="/fonts/fonts.css"><link rel="stylesheet" href="/rer-theme.css"><link rel="stylesheet" href="/nectar.css">${script ? h`<script src="${script}" defer></script>` : ''}</head><body>
<div class="shell${nav ? '' : ' bare'}"><aside class="side"><div class="side-head"><a class="brand" href="/app"><img src="/brand/mark.svg" alt="" width="36" height="36"><span data-rer-name>${branding.name}</span></a>${menu}</div>${nav ? raw('<input type="checkbox" id="menu" class="menu-toggle" aria-label="Show the menu">') : ''}${nav}${who}</aside>
<div class="column">${top}<main>${notice ? h`<p class="flash" role="status">${icon('paid')}<span>${notice}</span></p>` : ''}${error ? h`<p class="flash error" role="alert">${icon('alert')}<span>That did not work: ${describeError(error)}</span></p>` : ''}${search}${body}</main></div></div></body></html>`
  // Only a page that names its own same-origin script may run one (GOV-007 passkeys).
  return new Response(document.html, { status, headers: script ? { ...headers, 'content-security-policy': headers['content-security-policy'].replace("default-src 'none';", "default-src 'none'; script-src 'self'; connect-src 'self';") } : headers })
}

const ERRORS: Record<string, string> = {
  stale: 'someone changed this record first. Reload and try again.',
  source_changed: 'the usage, prices, contract terms or tax behind this invoice changed after it was prepared or approved. Prepare the bill run again and review it.',
  already_billed: 'some of this usage has already been billed on an issued invoice.',
  exceeds_balance: 'that is more than the invoice still owes.',
  exceeds_payment: 'that is more than is left unallocated on this payment.',
  tax_not_reviewed: 'the owner must review the declared tax policy before invoices can be finalized.',
  tax_not_declared: 'declare the tax policy first.',
  blocking_exception: 'this draft has an exception that must be fixed before approval.',
  exceptions_not_acknowledged: 'tick that you reviewed the exceptions listed for this draft.',
  shadow_invoice: 'this is a shadow draft for comparison with the previous biller; it cannot be approved until the subscription is adopted.',
  price_request_stale: 'another price version was published. Reject this request and prepare it again.',
  price_already_decided: 'this price request was already decided.',
  policy_changed: 'this policy changed after preparation. Reject the request and prepare it again.',
  single_confirmation_required: 'confirm the exact change as single approver before applying it.',
  policy_already_decided: 'this policy request was already decided.',
  second_approver_required: 'another approver must approve this action; the person who prepared it cannot approve it.',
  price_switch_needs_preparation: 'this older price switch has no saved preparer identity. Discard it and preview it again.',
  price_override_needs_preparation: 'this older contract price has no saved preparer identity. Reject it and propose it again.',
  price_proposal_needs_preparation: 'this older price proposal has no saved preparer identity. Reject it and prepare a new proposal.',
  proposal_stale: 'the records changed after this proposal was prepared. Ask for a new proposal.',
  correction_rows_rejected: 'some added usage rows would be rejected. Fix them and propose the correction again.',
  reviewed_fingerprint_changed: 'the files changed since they were reviewed. Preview them again.',
  undo_blocked: 'some moved-in records were edited or billed since the import. Reverse those first.',
  business_not_configured: 'the owner must enter the business details first.',
  record_is_immutable: 'this record is kept as history and cannot be changed.',
  person_required: 'a person must make this decision; agent credentials can only prepare it.',
  forbidden: 'your role does not allow this.',
  owner_required: 'only the owner can do this.',
  meter_already_billed: 'another subscription of this customer already bills that meter.',
  period_already_invoiced: 'that period is already invoiced; record a credit note instead.',
  cutover_overlaps_previous_biller: 'the previous biller already billed that period. Choose a later cutover.',
  shadow_not_reconciled: 'no shadow period agrees with the previous biller yet. Reconcile, or confirm that you accept the difference.',
  balances_changed: 'the balances changed since this reminder was drafted. Prepare it again.',
  timezone_fixed_after_first_invoice: 'the billing timezone cannot change once an invoice is issued.',
  mfa_required: 'confirm it’s you with your second factor on Sign-in security first.',
  mfa_enrollment_required: 'enroll a second factor on Sign-in security first.',
  mfa_step_up_required: 'your last check is more than 15 minutes old. Confirm it’s you on Sign-in security, then try again.',
  mfa_code_invalid: 'that code is not right, or it was already used.',
  mfa_locked: 'too many wrong codes. Wait 15 minutes and try again.',
  mfa_key_missing: 'this installation has no MFA key, so authenticator apps cannot be set up. Use a passkey, or ask the owner to set MFA_KEY.',
  mfa_key_changed: 'this installation’s MFA key cannot open that authenticator secret. Set it up again.',
}
export const describeError = (code: string) => ERRORS[code] ?? code.replace(/_/g, ' ') + '.'

export const hidden = (name: string, value: unknown) => h`<input type="hidden" name="${name}" value="${value}">`

/** A POST form to the shared action door; returnTo may contain {id} for the created record. */
/** `primary` marks the one decision a screen leads with: its button carries the brand gradient. */
export function form(action: string, returnTo: string, fields: unknown, submit: string, { multipart = false, secondary = false, primary = false, layout = '' } = {}) {
  return h`<form method="post" action="/app/do/${action}"${layout ? h` class="${layout}"` : ''}${multipart ? raw(' enctype="multipart/form-data"') : ''}>${hidden('returnTo', returnTo)}${fields}<button type="submit"${secondary ? raw(' class="secondary"') : primary ? raw(' class="cta"') : ''}>${submit}</button></form>`
}

// Several forms share a page, so every control gets its own id.
let sequence = 0
const uid = (name: string) => `f-${name.replace(/[^\w-]/g, '')}-${(sequence = (sequence + 1) % 1_000_000)}`

export function field(label: string, name: string, { type = 'text', value = '', required = true, hint = '', step = '' }: { type?: string; value?: unknown; required?: boolean; hint?: string; step?: string } = {}) {
  const id = uid(name)
  return h`<div class="field"><label for="${id}">${label}</label><input id="${id}" type="${type}" name="${name}" value="${value}"${step ? h` step="${step}"` : ''}${required ? raw(' required') : ''}${hint ? raw(` aria-describedby="${esc(id)}-hint"`) : ''}>${fieldHint(id, hint)}</div>`
}
const fieldHint = (id: string, hint: string) => hint ? h`<p class="hint" id="${id}-hint">${hint}</p>` : ''

export function area(label: string, name: string, value = '', required = true, rows = 4) {
  const id = uid(name)
  return h`<div class="field"><label for="${id}">${label}</label><textarea id="${id}" name="${name}" rows="${rows}"${required ? raw(' required') : ''}>${value}</textarea></div>`
}

export function select(label: string, name: string, options: { value: string; label: string }[], selected = '', { required = true, blank = '', hint = '' } = {}) {
  const id = uid(name)
  return h`<div class="field"><label for="${id}">${label}</label><select id="${id}" name="${name}"${required ? raw(' required') : ''}${hint ? raw(` aria-describedby="${esc(id)}-hint"`) : ''}>${blank ? h`<option value="">${blank}</option>` : ''}${options.map(option => h`<option value="${option.value}"${option.value === selected ? raw(' selected') : ''}>${option.label}</option>`)}</select>${fieldHint(id, hint)}</div>`
}

export function fileField(label: string, name: string, { required = false, accept = '', hint = '' } = {}) {
  const id = uid(name)
  return h`<div class="field"><label for="${id}">${label}</label><input id="${id}" type="file" name="${name}"${accept ? h` accept="${accept}"` : ''}${required ? raw(' required') : ''}${hint ? raw(` aria-describedby="${esc(id)}-hint"`) : ''}>${fieldHint(id, hint)}</div>`
}

export function check(label: string, name: string, { checked = false, value = 'yes' } = {}) {
  return h`<label class="check"><input type="checkbox" name="${name}" value="${value}"${checked ? raw(' checked') : ''}> ${label}</label>`
}

export const checks = (legend: string, name: string, options: { value: string; label: string }[], selected: string[] = []) =>
  h`<fieldset><legend>${legend}</legend>${options.map(option => check(option.label, name, { value: option.value, checked: selected.includes(option.value) }))}</fieldset>`

// On a phone each row stacks as label and value pairs; data-label carries the column heading.
// Columns whose heading ends in '$' are right-aligned numbers (the '$' is not shown).
// `lead` marks a page's main list: its empty state is drawn larger, with an icon.
// `lines` marks invoice lines: on a phone their quantity, unit and amount share one row.
// Empty cells are marked so a phone card leaves out their label; text cells wrap addresses only at "@" or ".".
const isEmpty = (cell: unknown) => cell === '' || cell === null || cell === undefined
export const table = (headers: string[], rows: unknown[][], { empty = 'Nothing here yet.', lead = false, lines = false } = {}) => rows.length
  ? h`<div class="table-wrap${lines ? ' lines' : ''}"><table><thead><tr>${headers.map(header => h`<th scope="col"${header.endsWith('$') ? raw(' class="num"') : ''}>${header.replace(/\$$/, '')}</th>`)}</tr></thead><tbody>${rows.map(row => h`<tr>${row.map((cell, index) => h`<td${headers[index] ? h` data-label="${headers[index].replace(/\$$/, '')}"` : ''}${headers[index]?.endsWith('$') ? raw(' class="num"') : ''}${isEmpty(cell) ? raw(' data-empty') : ''}>${typeof cell === 'string' ? addresses(cell) : cell}</td>`)}</tr>`)}</tbody></table></div>`
  : emptyState(empty, lead)

/** An empty state: its first sentence carries the news, the rest says what to do. */
export function emptyState(text: string, lead = false) {
  const stop = text.indexOf('. ')
  const [first, rest] = stop === -1 ? [text, ''] : [text.slice(0, stop + 1), text.slice(stop + 2)]
  return h`<p class="empty${lead ? ' lead' : ''}">${lead ? h`<span class="empty-art">${icon('proposals')}</span>` : ''}<b>${first}</b>${rest ? ` ${rest}` : ''}</p>`
}

/** A state marker beside a step or an exception: done, still open, needs attention, or a plain item. */
export function marker(kind: 'done' | 'open' | 'alert' | 'plain') {
  return h`<span class="marker marker-${kind}">${icon(kind === 'done' ? 'paid' : kind === 'open' ? 'open' : kind === 'alert' ? 'alert' : 'arrow')}</span>`
}

const TONES: Record<string, 'good' | 'pending' | 'alert'> = {
  issued: 'good', approved: 'good', paid: 'good', active: 'good', live: 'good', done: 'good', exported: 'good', completed: 'good', reconciled: 'good', reviewed: 'good', allowed: 'good', finalised: 'good',
  draft: 'pending', shadow: 'pending', proposed: 'pending', pending: 'pending', open: 'pending', trial: 'pending', trialing: 'pending', 'not reviewed': 'pending', 'partly paid': 'pending',
  overdue: 'alert', 'needs review': 'alert', rejected: 'alert', stale: 'alert', 'not reconciled': 'alert', denied: 'alert', blocked: 'alert', ended: 'alert', revoked: 'alert',
}
/** A status chip, toned by its words; the words carry the meaning, the tone only supports them. */
export const tag = (text: unknown) => { const tone = TONES[String(text ?? '').toLowerCase()]; return h`<span class="tag${tone ? ` tone-${tone}` : ''}">${text}</span>` }

export const cents = (value: number | null | undefined) => value === null || value === undefined ? '—' : money(value)

/** Machine facts stay out of the work view, inside a keyboard-operable Details disclosure. */
export const details = (facts: Record<string, unknown>, summary = 'Details') =>
  h`<details class="facts"><summary>${summary}</summary><dl>${Object.entries(facts).map(([key, value]) => h`<dt>${key}</dt><dd><code>${addresses(typeof value === 'string' ? value : JSON.stringify(value, null, 1))}</code></dd>`)}</dl></details>`

/** An instant as people read it, in the business's billing timezone. */
export const when = (ms: number | null | undefined, zone: string) => ms ? formatInstant(ms, zone) : '—'
