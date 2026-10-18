// Home (the first-run checklist and today's work), More, business and tax
// settings, access and credentials, and the audit trail.
import type { Bindings } from '../../auth.server'
import { agentKeys, members } from '../access'
import { ROLE_LABELS, SCOPES, can, type Actor } from '../actor'
import { US_STATES, business, taxReady } from '../business'
import { one } from '../core'
import { money } from '../decimal'
import { audit } from '../views'
import { MORE, check, checks, details, emptyState, field, form, h, hexMarker, hidden, page, select, table, tag, when } from './html'

const count = async (env: Bindings, sql: string, ...params: unknown[]) => (await one<{ n: number }>(env, sql, ...params))!.n

export async function homePage(env: Bindings, actor: Actor, url: URL) {
  const b = (await business(env))!
  const steps = [
    { done: true, label: 'Enter the business billing details', href: '/app/settings' },
    { done: taxReady(b), label: b.tax_mode === 'undeclared' ? 'Declare the tax policy' : 'Have the owner review the declared tax policy', href: '/app/settings' },
    { done: await count(env, 'SELECT COUNT(*) AS n FROM nc_prices') > 0, label: 'Add a product and its price', href: '/app/catalog' },
    { done: await count(env, 'SELECT COUNT(*) AS n FROM nc_customers') > 0, label: 'Add a customer, or move in from Stripe', href: '/app/customers' },
    { done: await count(env, 'SELECT COUNT(*) AS n FROM nc_subscriptions') > 0, label: 'Start a subscription', href: '/app/customers' },
    { done: await count(env, "SELECT COUNT(*) AS n FROM nc_invoices WHERE status = 'issued'") > 0, label: 'Prepare, approve and finalize a bill run', href: '/app/billing' },
  ]
  const remaining = steps.filter(step => !step.done)
  const pending = await count(env, "SELECT COUNT(*) AS n FROM nc_proposals WHERE status = 'pending'")
  const drafts = await count(env, "SELECT COUNT(*) AS n FROM nc_bill_runs WHERE status = 'draft'")
  const changes = await count(env, "SELECT COUNT(*) AS n FROM nc_changes WHERE status = 'draft'") + await count(env, "SELECT COUNT(*) AS n FROM nc_amendments WHERE status = 'proposed'")
  const overdue = await one<{ n: number; total: number }>(env, `SELECT COUNT(*) AS n, COALESCE(SUM(i.total_cents - COALESCE((SELECT SUM(amount_cents) FROM nc_credit_notes WHERE invoice_id = i.id), 0) - COALESCE((SELECT SUM(amount_cents) FROM nc_allocations WHERE invoice_id = i.id), 0)), 0) AS total
    FROM nc_invoices i WHERE i.status = 'issued' AND i.due_date < date('now') AND i.total_cents > COALESCE((SELECT SUM(amount_cents) FROM nc_credit_notes WHERE invoice_id = i.id), 0) + COALESCE((SELECT SUM(amount_cents) FROM nc_allocations WHERE invoice_id = i.id), 0)`)
  const tasksOpen = await count(env, "SELECT COUNT(*) AS n FROM nc_tasks WHERE status = 'open'")
  const work = [
    pending && { label: `${pending} proposal${pending === 1 ? '' : 's'} waiting for a decision`, href: '/app/proposals' },
    drafts && { label: `${drafts} draft bill run${drafts === 1 ? '' : 's'} to review`, href: '/app/billing' },
    changes && { label: `${changes} contract exception${changes === 1 ? '' : 's'} or scheduled change${changes === 1 ? '' : 's'} awaiting approval`, href: '/app/customers' },
    overdue?.n && { label: `${overdue.n} overdue invoice${overdue.n === 1 ? '' : 's'}, ${money(overdue.total)} outstanding`, href: '/app/receivables' },
    tasksOpen && { label: `${tasksOpen} open follow-up task${tasksOpen === 1 ? '' : 's'}`, href: '/app/receivables' },
  ].filter(Boolean) as { label: string; href: string }[]
  const checklist = remaining.length ? h`<section class="card checklist" aria-labelledby="first-run"><h2 id="first-run">Finish your first billing cycle</h2><ol>${steps.map(step => h`<li class="${step.done ? 'done' : ''}">${hexMarker(step.done ? 'done' : 'open')}${step.done ? h`<span>${step.label}</span><span class="sr"> (done)</span>` : h`<a href="${step.href}">${step.label}</a>`}</li>`)}</ol></section>` : ''
  const today = h`<section class="card" aria-labelledby="today"><h2 id="today">Your work</h2>${work.length ? h`<ul class="work">${work.map(item => h`<li><a href="${item.href}">${hexMarker('plain')}<span>${item.label}</span></a></li>`)}</ul>` : emptyState('Nothing is waiting for you. New proposals, draft bill runs and overdue invoices appear here.')}</section>`
  return page('Home', actor, h`<h1>${b.legal_name}</h1>${checklist ? h`<div class="split home">${checklist}${today}</div>` : today}`, { current: '/app', url })
}

export async function morePage(_env: Bindings, actor: Actor, url: URL) {
  return page('More', actor, h`<h1>More</h1><ul class="more">${MORE.filter(item => item.show(actor)).map(item => h`<li><a href="${item.href}">${item.label}</a><p>${item.about}</p></li>`)}</ul>`, { current: '/app/more', url })
}

const ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'UTC']

export async function settingsPage(env: Bindings, actor: Actor, url: URL) {
  const b = await business(env)
  const owner = actor.role === 'owner'
  const identity = owner
    ? form('business.configure', '/app/settings', h`${b ? hidden('revision', b.revision) : ''}
      ${field('Legal name', 'legal_name', { value: b?.legal_name ?? '' })}
      ${field('Billing address', 'address', { value: b?.address ?? '', required: false })}
      ${field('Billing email (shown on invoices)', 'billing_email', { type: 'email', value: b?.billing_email ?? '', required: false })}
      ${select('Billing timezone', 'timezone', ZONES.map(zone => ({ value: zone, label: zone })), b?.timezone ?? 'America/New_York', { hint: 'Billing periods start and end at midnight in this timezone. It cannot change once an invoice is issued.' })}
      ${field('Invoice number prefix', 'invoice_prefix', { value: b?.invoice_prefix ?? 'INV', hint: 'Letters, digits and dashes; invoices are numbered PREFIX-000001 upward.' })}
      ${field('Payment terms (days)', 'payment_terms_days', { type: 'number', value: b?.payment_terms_days ?? 30 })}
      ${hidden('currency', 'USD')}<p class="hint">Currency: US dollars.</p>`, b ? 'Save business details' : 'Save and continue', { layout: 'columns' })
    : h`<p>Only the owner changes the business details.</p>`
  const tax = b ? h`<section class="card" aria-labelledby="tax"><div class="card-head"><h2 id="tax">Tax policy</h2>${b.tax_mode !== 'undeclared' ? tag(taxReady(b) ? 'Reviewed' : 'Not reviewed') : ''}</div>
    <p class="declared">Declared: ${b.tax_mode === 'undeclared' ? tag('Not declared') : h`<strong>${b.tax_mode === 'no_tax' ? 'No sales tax applies' : `Flat rate ${b.tax_rate}%`} in ${b.tax_jurisdiction}</strong>`}</p>
    ${b.tax_note ? h`<p class="hint">${b.tax_note}</p>` : ''}
    <p class="hint">Nectar applies the policy you declare; it does not determine where you owe tax or file returns. Invoices cannot be finalized until the owner reviews the declaration, and any change needs a new review.</p>
    ${owner ? h`${form('tax.declare', '/app/settings', h`${select('State', 'tax_jurisdiction', US_STATES.map(s => ({ value: s, label: s })), b.tax_jurisdiction || 'NY')}
      ${select('Policy', 'tax_mode', [{ value: 'no_tax', label: 'No sales tax applies to what we sell' }, { value: 'flat_rate', label: 'Charge one flat rate on taxable lines' }], b.tax_mode === 'undeclared' ? 'no_tax' : b.tax_mode)}
      ${field('Rate (%) for a flat rate', 'tax_rate', { value: b.tax_mode === 'flat_rate' ? b.tax_rate : '', required: false })}
      ${field('Basis for this declaration', 'tax_note', { value: b.tax_note, hint: 'For example: who advised it and when.' })}`, 'Declare tax policy', { layout: 'columns' })}
      ${b.tax_mode !== 'undeclared' && !taxReady(b) ? form('tax.review', '/app/settings', hidden('revision', b.revision), 'I have reviewed this tax policy') : ''}` : ''}
    ${b.tax_reviewed_at ? details({ 'Reviewed by': b.tax_reviewed_by, 'Reviewed at': when(b.tax_reviewed_at, b.timezone) }) : ''}</section>` : ''
  const identityCard = h`<section class="card" aria-labelledby="identity"><h2 id="identity">Billing identity</h2>${identity}</section>`
  return page('Business and tax', actor, h`<h1>Business and tax</h1>${tax ? h`<div class="split settings">${identityCard}${tax}</div>` : identityCard}`, { current: '/app/settings', url, showNav: !!b })
}

export async function accessPage(env: Bindings, actor: Actor, url: URL, issued?: { name: string; key: string }) {
  const people = await members(env, actor)
  const keys = await agentKeys(env, actor)
  const zone = (await business(env))!.timezone
  return page('Access', actor, h`<h1>Access</h1>
    ${issued ? h`<section class="card key" aria-labelledby="new-key"><h2 id="new-key">Credential for ${issued.name}</h2><p>Copy it now; Nectar keeps only its fingerprint and cannot show it again.</p><p><code class="secret">${issued.key}</code></p><p class="hint">Send it as <code>Authorization: Bearer …</code> to <code>/api/nectar/</code>.</p></section>` : ''}
    <section class="card" aria-labelledby="people"><h2 id="people">People</h2>
    ${table(['Name', 'Email', 'Role', 'Status', ''], people.map(m => [m.name, m.email, m.role, tag(m.status === 'active' ? 'Active' : 'Ended'), m.role !== 'owner' && m.status === 'active' ? form('access.end', '/app/access', hidden('member', m.id), 'End access', { secondary: true }) : '']))}
    <h3>Give someone access</h3>${form('access.give', '/app/access', h`${field('Name', 'name')}${field('Email', 'email', { type: 'email' })}${select('Role', 'role', [{ value: 'finance', label: ROLE_LABELS.finance }, { value: 'accountant', label: ROLE_LABELS.accountant }], 'finance')}`, 'Invite', { layout: 'columns' })}</section>
    <section class="card" aria-labelledby="agents"><h2 id="agents">Agent credentials</h2><p class="hint">A credential lets your own agent read and prepare proposals, or lets a metering pipeline submit usage. Credentials never approve, finalize or change records directly.</p>
    ${table(['Name', 'Scopes', 'Last used', 'Status', ''], keys.map(k => [k.name, k.scopes, when(k.last_used_at, zone), tag(k.revoked_at ? 'Revoked' : 'Active'), k.revoked_at ? '' : form('credential.revoke', '/app/access', hidden('key', k.id), 'Revoke', { secondary: true })]), { empty: 'No credentials issued.' })}
    <h3>Issue a credential</h3><form method="post" action="/app/access/credential" class="columns">${field('Name', 'name', { hint: 'For example: "Finance agent" or "Metering pipeline".' })}${checks('Scopes', 'scopes', Object.keys(SCOPES).map(scope => ({ value: scope, label: scope === 'prepare' ? 'prepare — read records and propose work for approval' : 'usage — submit usage events' })), ['prepare'])}<button type="submit">Issue credential</button></form></section>`, { current: '/app/access', url })
}

export async function auditPage(env: Bindings, actor: Actor, url: URL) {
  const rows = await audit(env, actor)
  const zone = (await business(env))!.timezone
  return page('Audit trail', actor, h`<h1>Audit trail</h1><p class="hint">Every change, approval and issue, newest first. The trail cannot be edited.</p>
    ${table(['When', 'Who', 'What', 'Details'], rows.map(r => [when(r.at, zone), r.actor, r.action.replace('.', ' '), details({ subject: r.subject, detail: r.detail })]))}`, { current: '/app/audit', url })
}

export const canExport = (actor: Actor) => can(actor, 'export')
export { check }
