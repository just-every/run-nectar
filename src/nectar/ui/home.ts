import { BALANCE_SQL } from '../receivables'
// Home (the first-run checklist and today's work), More, business and tax
// settings, access and credentials, and the audit trail.
import { invoiceBrandingForm, invoiceFieldsForm } from './invoice-content'
import type { Bindings } from '../../auth.server'
import { agentKeys, customRoles, members } from '../access'
import { LATEST_VERSION, VERSIONS } from '../api-versions'
import { canRead, CUSTOM_CAPABILITIES, ROLE_LABELS, ROLE_NAMES, SCOPES, can, type Actor, type Capability } from '../actor'
import { US_STATES, business, taxReady } from '../business'
import { all, one, parseJson } from '../core'
import { money } from '../decimal'
import { audit } from '../views'
import { MORE, check, checks, details, emptyState, field, form, h, marker, hidden, page, select, table, tag, when } from './html'
import { policySection } from './policies'
import { personName } from './shell'
import { notificationSection } from './notifications'
import { DEFAULT_ROLES, memberFactors, mfaPolicy } from '../mfa'

// GOV-001: a work item or first-run step shows only to a member who can open it.
const opens = (actor: Actor, href: string) => href === '/app/customers' ? canRead(actor, 'customers') : href === '/app/receivables' ? canRead(actor, 'customers') && canRead(actor, 'invoices') && canRead(actor, 'payments') : href === '/app/catalog' ? canRead(actor, 'catalog') : can(actor, 'read')

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
  const remaining = can(actor, 'read') ? steps.filter(step => !step.done) : []
  const pending = await count(env, "SELECT COUNT(*) AS n FROM nc_proposals WHERE status = 'pending'")
  const drafts = await count(env, "SELECT COUNT(*) AS n FROM nc_bill_runs WHERE status = 'draft'")
  const changes = await count(env, "SELECT COUNT(*) AS n FROM nc_changes WHERE status = 'draft'") + await count(env, "SELECT COUNT(*) AS n FROM nc_amendments WHERE status = 'proposed'")
  const overdueGroups=await all<{n:number;total:number;currency:string}>(env,`SELECT COUNT(*) AS n,COALESCE(SUM(${BALANCE_SQL}),0) AS total,i.currency FROM nc_invoices i WHERE i.status='issued' AND i.due_date<date('now') AND ${BALANCE_SQL}>0 GROUP BY i.currency ORDER BY i.currency`)
  const overdue={n:overdueGroups.reduce((sum,row)=>sum+row.n,0),amounts:overdueGroups.map(row=>money(row.total,row.currency)).join(' + ')}
  const tasksOpen = await count(env, "SELECT COUNT(*) AS n FROM nc_tasks WHERE status = 'open'")
  const work = [
    pending && { label: `${pending} proposal${pending === 1 ? '' : 's'} waiting for a decision`, href: '/app/proposals' },
    drafts && { label: `${drafts} draft bill run${drafts === 1 ? '' : 's'} to review`, href: '/app/billing' },
    changes && { label: `${changes} contract exception${changes === 1 ? '' : 's'} or scheduled change${changes === 1 ? '' : 's'} awaiting approval`, href: '/app/customers' },
    overdue?.n && { label: `${overdue.n} overdue invoice${overdue.n === 1 ? '' : 's'}, ${overdue.amounts} outstanding`, href: '/app/receivables' },
    tasksOpen && { label: `${tasksOpen} open follow-up task${tasksOpen === 1 ? '' : 's'}`, href: '/app/receivables' },
  ].filter(Boolean).filter(item => opens(actor, (item as { href: string }).href)) as { label: string; href: string }[]
  const checklist = remaining.length ? h`<section class="card checklist" aria-labelledby="first-run"><h2 id="first-run">Finish your first billing cycle</h2><ol>${steps.map(step => h`<li class="${step.done ? 'done' : ''}">${marker(step.done ? 'done' : 'open')}${step.done ? h`<span>${step.label}</span><span class="sr"> (done)</span>` : h`<a href="${step.href}">${step.label}</a>`}</li>`)}</ol></section>` : ''
  const today = h`<section class="card" aria-labelledby="today"><h2 id="today">Your work</h2>${work.length ? h`<ul class="work">${work.map(item => h`<li><a href="${item.href}">${marker('plain')}<span>${item.label}</span></a></li>`)}</ul>` : emptyState('Nothing is waiting for you. New proposals, draft bill runs and overdue invoices appear here.')}</section>`
  return page('Home', actor, h`<h1>${b.legal_name}</h1>${checklist ? h`<div class="split home">${checklist}${today}</div>` : today}`, { current: '/app', url })
}

export async function morePage(env: Bindings, actor: Actor, url: URL) {
  return page('More', actor, h`<h1>More</h1><ul class="more">${MORE.filter(item => item.show(actor)).map(item => h`<li><a href="${item.href}">${item.label}</a><p>${item.about}</p></li>`)}</ul>${await notificationSection(env,actor)}`, { current: '/app/more', url })
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
      ${field('Invoice number prefix', 'invoice_prefix', { value: b?.invoice_prefix ?? 'INV', hint: 'Letters, digits and dashes. Manage continuation and digit width in the number register.' })}
      ${field('Payment terms (days)', 'payment_terms_days', { type: 'number', value: b?.payment_terms_days ?? 30 })}
      ${hidden('invoice_fields_edit','yes')}${invoiceFieldsForm(parseJson(b?.invoice_fields_json, {}))}
      ${invoiceBrandingForm(b?.invoice_branding_json)}${hidden('currency', 'USD')}<p class="hint">Currency: US dollars.</p>`, b ? 'Save business details' : 'Save and continue', { layout: 'columns', multipart: true })
    : h`<p>Only the owner changes the business details.</p>`
  const tax = b ? h`<section class="card" aria-labelledby="tax"><div class="card-head"><h2 id="tax">Tax policy</h2>${b.tax_mode !== 'undeclared' ? tag(taxReady(b) ? 'Reviewed' : 'Not reviewed') : ''}</div>
    <p class="declared">Declared: ${b.tax_mode === 'undeclared' ? tag('Not declared') : h`<strong>${b.tax_mode === 'no_tax' ? 'No sales tax applies' : `Flat rate ${b.tax_rate}%`} in ${b.tax_jurisdiction}</strong>`}</p>
    ${b.tax_note ? h`<p class="hint">${b.tax_note}</p>` : ''}
    <p class="hint">Nectar applies the policy you declare; it does not determine where you owe tax or file returns. Invoices cannot be finalized until the owner reviews the declaration, and any change needs a new review.</p>
    ${owner ? h`${form('tax.declare', '/app/settings', h`${select('State', 'tax_jurisdiction', US_STATES.map(s => ({ value: s, label: s })), b.tax_jurisdiction || 'NY')}
      ${select('Policy', 'tax_mode', [{ value: 'no_tax', label: 'No sales tax applies to what we sell' }, { value: 'flat_rate', label: 'Charge one flat rate on taxable lines' }], b.tax_mode === 'undeclared' ? 'no_tax' : b.tax_mode)}
      ${field('Rate (%) for a flat rate', 'tax_rate', { value: b.tax_mode === 'flat_rate' ? b.tax_rate : '', required: false })}
      ${field('Basis for this declaration', 'tax_note', { value: b.tax_note, hint: 'For example: who advised it and when.' })}`, 'Prepare tax policy', { layout: 'columns' })}
      ${b.tax_mode !== 'undeclared' && !taxReady(b) ? form('tax.review', '/app/settings', hidden('revision', b.revision), 'I have reviewed this tax policy') : ''}` : ''}
    ${b.tax_reviewed_at ? details({ 'Reviewed by': personName(actor, b.tax_reviewed_by), 'Reviewed at': when(b.tax_reviewed_at, b.timezone) }) : ''}</section>` : ''
  const identityCard = h`<section class="card" aria-labelledby="identity"><h2 id="identity">Billing identity</h2><p><a href="/app/numbering">Invoice series and number register</a></p>${identity}</section>`
  return page('Business and tax', actor, h`<h1>Business and tax</h1><p><a href="/app/more#notifications">Manage your email notifications</a></p>${tax ? h`<div class="split settings">${identityCard}${tax}</div>` : identityCard}${await policySection(env, actor)}`, { current: '/app/settings', url, showNav: !!b })
}

const CAPABILITY_LABELS: Partial<Record<Capability, string>> = {
  'read.customers': 'Read customers', 'read.catalog': 'Read catalog', 'read.subscriptions': 'Read subscriptions', 'read.invoices': 'Read invoices', 'read.payments': 'Read payments',
  'read.reports': 'Read reports', export: 'Export (downloads of what the role can read)', notes: 'Add notes', receivables: 'Record and allocate payments, reminders and follow-up tasks',
  draft: 'Prepare plan changes, amendments and order setups for approval', 'credits.limited': 'Credits up to the support limit', propose: 'Propose credits from billing answers for approval',
}
const capabilityChoices = () => CUSTOM_CAPABILITIES.map(value => ({ value, label: CAPABILITY_LABELS[value] ?? value }))

export async function accessPage(env: Bindings, actor: Actor, url: URL, issued?: { name: string; key: string }) {
  // A developer manages credentials here; people, roles and sign-in rules stay with the owner (GOV-001).
  const owner = actor.role === 'owner'
  const keys = await agentKeys(env, actor)
  const zone = (await business(env))!.timezone
  const scopes = [{ value: 'off', label: 'Not required' }, { value: 'roles', label: 'Required for the chosen roles' }, { value: 'all', label: 'Required for everyone (installation-wide)' }]
  const ownerSections = async () => {
    const people = await members(env, actor), roles = await customRoles(env, actor)
    const policy = await mfaPolicy(env), factors = await memberFactors(env)
    const grantable = (['finance', 'accountant', 'collections', 'sales', 'support', 'developer'] as const).map(role => ({ value: role, label: ROLE_LABELS[role] }))
    return h`<section class="card" aria-labelledby="people"><h2 id="people">People</h2>
    ${table(['Name', 'Email', 'Role', 'Status', 'Second factor', ''], people.map(m => [m.name, m.email, m.custom_role ?? ROLE_NAMES[m.role], tag(m.status === 'active' ? 'Active' : 'Ended'), factors.get(m.id) ? h`${factors.get(m.id)} enrolled ${form('mfa.reset', '/app/access', hidden('member', m.id), 'Reset factor', { secondary: true })}` : 'None', m.role !== 'owner' && m.status === 'active' ? form('access.end', '/app/access', hidden('member', m.id), 'End access', { secondary: true }) : '']))}
    <h3>Give someone access</h3>${form('access.give', '/app/access', h`${field('Name', 'name')}${field('Email', 'email', { type: 'email' })}${select('Role', 'role', [...grantable, ...(roles.length ? [{ value: 'custom', label: 'Custom role (choose it below)' }] : [])], 'finance')}${roles.length ? select('Custom role', 'custom_role', roles.map(r => ({ value: r.id, label: r.name })), '', { required: false, blank: '—' }) : ''}`, 'Invite', { layout: 'columns' })}</section>
    <section class="card" aria-labelledby="roles"><h2 id="roles">Custom roles</h2><p class="hint">A custom role holds only the capabilities ticked here. A change applies to every member in the role from their next request, without signing them out. Custom roles never change settings, access, credentials or approvals.</p>
    ${roles.map(r => h`<article><h3>${r.name}</h3>${form('role.update', '/app/access#roles', h`${hidden('role', r.id)}${hidden('revision', r.revision)}${checks('Capabilities', 'capabilities', capabilityChoices(), r.capabilities)}`, `Save ${r.name}`, { secondary: true })}</article>`)}
    <h3>Define a custom role</h3>${form('role.define', '/app/access#roles', h`${field('Role name', 'name', { hint: 'For example: "Billing analyst".' })}${checks('Capabilities', 'capabilities', capabilityChoices(), [])}`, 'Define role', { layout: 'columns' })}</section>
    <section class="card" aria-labelledby="mfa"><h2 id="mfa">Multi-factor sign-in</h2><p class="hint">A required member enrolls an authenticator app or a passkey and presents it in every session before any page, form, API call or download opens; credits above the support limit, access and credential changes and the move-in cutover ask again after 15 minutes. Resetting a member’s factor signs them out everywhere.</p>
    ${form('mfa.policy', '/app/access', h`${select('Requirement', 'scope', scopes, policy.scope)}${checks('Roles that must use it', 'roles', (['owner', 'finance', 'accountant', 'collections', 'sales', 'support', 'developer', 'custom'] as const).map(role => ({ value: role, label: ROLE_NAMES[role] })), policy.scope === 'roles' ? policy.roles : DEFAULT_ROLES)}`, 'Save requirement', { layout: 'columns' })}</section>`
  }
  return page('Access', actor, h`<h1>Access</h1>
    ${issued ? h`<section class="card key" aria-labelledby="new-key"><h2 id="new-key">Credential for ${issued.name}</h2><p>Copy it now; Nectar keeps only its fingerprint and cannot show it again.</p><p><code class="secret">${issued.key}</code></p><p class="hint">Send it as <code>Authorization: Bearer …</code> to <code>/api/nectar/</code>.</p></section>` : ''}
    ${owner ? await ownerSections() : ''}
    <section class="card" aria-labelledby="agents"><h2 id="agents">Agent credentials</h2><p class="hint">A credential lets your own agent read and prepare proposals, or lets a metering pipeline submit usage. Credentials never approve, finalize or change records directly.</p>
    ${table(['Name', 'Scopes', 'API version', 'Last used', 'Status', ''], keys.map(k => [k.name, k.scopes, k.revoked_at ? k.api_version : form('credential.version', '/app/access', h`${hidden('key', k.id)}${versionSelect(k.api_version)}`, 'Pin version', { secondary: true }), when(k.last_used_at, zone), tag(k.revoked_at ? 'Revoked' : 'Active'), k.revoked_at ? '' : form('credential.revoke', '/app/access', hidden('key', k.id), 'Revoke', { secondary: true })]), { empty: 'No credentials issued.' })}
    <h3>Issue a credential</h3><form method="post" action="/app/access/credential" class="columns">${field('Name', 'name', { hint: 'For example: "Finance agent" or "Metering pipeline".' })}${checks('Scopes', 'scopes', Object.keys(SCOPES).map(scope => ({ value: scope, label: scope === 'prepare' ? 'prepare — read records and propose work for approval' : 'usage — submit usage events' })), ['prepare'])}${versionSelect(LATEST_VERSION, 'Responses use this dated shape unless a request sends a Nectar-Version header.')}<button type="submit">Issue credential</button></form></section>`, { current: '/app/access', url })
}

const versionSelect = (selected: string, hint = '') => select('API version', 'api_version', VERSIONS.map(version => ({ value: version, label: version === LATEST_VERSION ? `${version} (latest)` : version })), selected, { hint })

// An audit entry's detail reads as fact rows: one per field, named in words ("legalName" reads "Legal name").
const words = (key: string) => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase().replace(/^./, first => first.toUpperCase())
const auditFacts = (subject: string, detail: unknown) => ({
  Record: subject,
  ...(detail && typeof detail === 'object' && !Array.isArray(detail) ? Object.fromEntries(Object.entries(detail).map(([key, value]) => [words(key), value ?? '—'])) : { Detail: detail }),
})

export async function auditPage(env: Bindings, actor: Actor, url: URL) {
  const rows = await audit(env, actor)
  const zone = (await business(env))!.timezone
  return page('Audit trail', actor, h`<h1>Audit trail</h1><p class="hint">Every change, approval and issue, newest first. The trail cannot be edited.</p>
    ${table(['When', 'Who', 'What', 'Details'], rows.map(r => [when(r.at, zone), personName(actor, r.actor), r.action.replace('.', ' '), details(auditFacts(r.subject, parseJson(r.detail, r.detail)))]))}`, { current: '/app/audit', url })
}

export const canExport = (actor: Actor) => can(actor, 'export')
export { check }
