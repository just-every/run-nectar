// Page frame and small form helpers. Every value is escaped; pages need no script.
import branding from '../../branding.json'
import { can, type Actor } from '../actor'
import { formatInstant } from '../dates'
import { money } from '../decimal'

export const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!))

export type Html = { html: string }
export const raw = (html: string): Html => ({ html })
export function h(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0]
  values.forEach((value, index) => { out += render(value) + strings[index + 1] })
  return { html: out }
}
function render(value: unknown): string {
  if (value === null || value === undefined || value === false) return ''
  if (Array.isArray(value)) return value.map(render).join('')
  if (typeof value === 'object' && 'html' in (value as Html)) return (value as Html).html
  return esc(value)
}

// Five work destinations and More (UI conventions §3).
export const NAV: { href: string; label: string }[] = [
  { href: '/app', label: 'Home' }, { href: '/app/customers', label: 'Customers' }, { href: '/app/usage', label: 'Usage' },
  { href: '/app/billing', label: 'Billing' }, { href: '/app/receivables', label: 'Receivables' },
]
export const MORE: { href: string; label: string; about: string; show: (actor: Actor) => boolean }[] = [
  { href: '/app/catalog', label: 'Catalog', about: 'Products, versioned prices, meters and the features each product grants.', show: () => true },
  { href: '/app/proposals', label: 'Proposals', about: 'Work an agent or a colleague prepared for your approval.', show: () => true },
  { href: '/app/import', label: 'Move in', about: 'Bring Stripe Billing records in, compare in shadow, then cut over.', show: actor => can(actor, 'records') },
  { href: '/app/exports', label: 'Exports', about: 'Invoices, usage, subscriptions and bill runs to keep or hand to your accountant.', show: actor => can(actor, 'export') },
  { href: '/app/settings', label: 'Business and tax', about: 'Billing identity, timezone, invoice numbering and the declared tax policy.', show: () => true },
  { href: '/app/access', label: 'Access', about: 'Who can sign in, their roles, and agent credentials.', show: actor => actor.role === 'owner' },
  { href: '/app/audit', label: 'Audit trail', about: 'Every change, approval and issue, with who made it.', show: actor => can(actor, 'export') },
]

const headers = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'strict-origin',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow',
  'content-security-policy': "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
}

const ROLE_NAMES = { owner: 'Owner', finance: 'Finance', accountant: 'Accountant' } as const

export function page(title: string, actor: Actor | null, body: Html, { current = '', url, status = 200, showNav = true }: { current?: string; url?: URL; status?: number; showNav?: boolean } = {}): Response {
  const notice = url?.searchParams.get('notice'), error = url?.searchParams.get('error')
  const inMore = MORE.some(item => item.href === current) || current === '/app/more'
  const nav = actor && showNav ? h`<nav aria-label="Main"><ul>${NAV.map(item => h`<li><a href="${item.href}"${item.href === current ? raw(' aria-current="page"') : ''}>${item.label}</a></li>`)}<li><a href="/app/more"${inMore ? raw(' aria-current="page"') : ''}>More</a></li></ul></nav>` : ''
  const role = actor?.role ? ROLE_NAMES[actor.role] : ''
  const name = actor && (!actor.name.trim() || actor.name.trim() === role) && actor.email ? actor.email : actor?.name
  const who = actor ? h`<span class="who${nav ? '' : ' alone'}"><span class="who-name">${name}</span>${role ? h` <span class="role">${role}</span>` : ''}</span>` : ''
  const document = h`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · ${branding.name}</title><link rel="preload" href="/fonts/hanken-grotesk/hanken-grotesk-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin="anonymous"><link rel="stylesheet" href="/fonts/fonts.css"><link rel="stylesheet" href="/rer-theme.css"><link rel="stylesheet" href="/nectar.css"></head><body>
<header class="top"><div class="top-inner"><a class="brand" href="/app"><img src="/brand/mark.svg" alt="" width="28" height="28">${branding.name}</a>${nav}${who}</div></header>
<main>${notice ? h`<p class="flash" role="status">${notice}</p>` : ''}${error ? h`<p class="flash error" role="alert">That did not work: ${describeError(error)}</p>` : ''}${body}</main></body></html>`
  return new Response(document.html, { status, headers })
}

const ERRORS: Record<string, string> = {
  stale: 'someone changed this record first. Reload and try again.',
  source_changed: 'the usage, prices, contract terms or tax behind this invoice changed after it was prepared or approved. Prepare the bill run again and review it.',
  already_billed: 'some of this usage has already been billed on an issued invoice.',
  exceeds_balance: 'that is more than the invoice still owes.',
  exceeds_payment: 'that is more than is left unallocated on this payment.',
  tax_not_reviewed: 'the owner must review the declared tax policy before invoices can be finalised.',
  tax_not_declared: 'declare the tax policy first.',
  blocking_exception: 'this draft has an exception that must be fixed before approval.',
  exceptions_not_acknowledged: 'tick that you reviewed the exceptions listed for this draft.',
  shadow_invoice: 'this is a shadow draft for comparison with the previous biller; it cannot be approved until the subscription is adopted.',
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
}
export const describeError = (code: string) => ERRORS[code] ?? code.replace(/_/g, ' ') + '.'

export const hidden = (name: string, value: unknown) => h`<input type="hidden" name="${name}" value="${value}">`

/** A POST form to the shared action door; returnTo may contain {id} for the created record. */
export function form(action: string, returnTo: string, fields: unknown, submit: string, { multipart = false, secondary = false, layout = '' } = {}) {
  return h`<form method="post" action="/app/do/${action}"${layout ? h` class="${layout}"` : ''}${multipart ? raw(' enctype="multipart/form-data"') : ''}>${hidden('returnTo', returnTo)}${fields}<button type="submit"${secondary ? raw(' class="secondary"') : ''}>${submit}</button></form>`
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
// `lead` marks a page's main list: its empty state gets the glass hexagons.
// `lines` marks invoice lines: on a phone their quantity, unit and amount share one row.
// Empty cells are marked so a phone card leaves out their label.
const isEmpty = (cell: unknown) => cell === '' || cell === null || cell === undefined
export const table = (headers: string[], rows: unknown[][], { empty = 'Nothing here yet.', lead = false, lines = false } = {}) => rows.length
  ? h`<div class="table-wrap${lines ? ' lines' : ''}"><table><thead><tr>${headers.map(header => h`<th scope="col"${header.endsWith('$') ? raw(' class="num"') : ''}>${header.replace(/\$$/, '')}</th>`)}</tr></thead><tbody>${rows.map(row => h`<tr>${row.map((cell, index) => h`<td${headers[index] ? h` data-label="${headers[index].replace(/\$$/, '')}"` : ''}${headers[index]?.endsWith('$') ? raw(' class="num"') : ''}${isEmpty(cell) ? raw(' data-empty') : ''}>${cell}</td>`)}</tr>`)}</tbody></table></div>`
  : emptyState(empty, lead)

/** An empty state: its first sentence carries the news, the rest says what to do. */
export function emptyState(text: string, lead = false) {
  const stop = text.indexOf('. ')
  const [first, rest] = stop === -1 ? [text, ''] : [text.slice(0, stop + 1), text.slice(stop + 2)]
  return h`<p class="empty${lead ? ' lead' : ''}">${lead ? raw(GLASS) : ''}<b>${first}</b>${rest ? ` ${rest}` : ''}</p>`
}

// Nectar's one shape. A pointy-top hexagon marker: filled honey (with a tick,
// a mark or nothing) or a hollow outline for a step still to do.
const HEX = 'M17 1.5 32 10.2v17.6L17 36.5 2 27.8V10.2Z'
export function hexMarker(kind: 'done' | 'open' | 'alert' | 'plain') {
  const shape = kind === 'open' ? `<path d="${HEX}" fill="#FFFFFF" stroke="#CFC6B6" stroke-width="1.6" stroke-linejoin="round"/>` : `<path d="${HEX}" fill="#F6B23E" stroke="#F6B23E" stroke-width="2" stroke-linejoin="round"/>`
  const tick = kind === 'done' ? '<path d="m11 19 4.2 4.2L23.5 14" fill="none" stroke="#1C1A17" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>' : ''
  return raw(`<span class="hex" aria-hidden="true"><svg viewBox="0 0 34 38">${shape}${tick}</svg>${kind === 'alert' ? '<b>!</b>' : ''}</span>`)
}
const GLASS_CELL = (x: number, y: number, r: number, id: string) => {
  const points = [0, 1, 2, 3, 4, 5].map(i => { const a = Math.PI / 3 * i; return `${(x + r * Math.cos(a)).toFixed(1)},${(y + r * Math.sin(a)).toFixed(1)}` }).join(' ')
  return `<polygon points="${points}" fill="url(#${id})" stroke="#F2B347" stroke-opacity=".75" stroke-width="2.5" stroke-linejoin="round"/><polygon points="${points}" fill="none" stroke="#FFFFFF" stroke-opacity=".7" stroke-width="1" transform="translate(${(x * 0.06).toFixed(1)} ${(y * 0.06).toFixed(1)}) scale(.94)"/>`
}
const GLASS = '<span class="empty-art" aria-hidden="true"><svg viewBox="0 0 240 200"><defs><linearGradient id="nglass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFF1CF"/><stop offset=".55" stop-color="#FAD27E"/><stop offset="1" stop-color="#F3B54A"/></linearGradient></defs>'
  + GLASS_CELL(92, 118, 62, 'nglass') + GLASS_CELL(158, 60, 40, 'nglass') + GLASS_CELL(178, 128, 34, 'nglass') + '</svg></span>'

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
  h`<details class="facts"><summary>${summary}</summary><dl>${Object.entries(facts).map(([key, value]) => h`<dt>${key}</dt><dd><code>${typeof value === 'string' ? value : JSON.stringify(value, null, 1)}</code></dd>`)}</dl></details>`

/** An instant as people read it, in the business's billing timezone. */
export const when = (ms: number | null | undefined, zone: string) => ms ? formatInstant(ms, zone) : '—'
