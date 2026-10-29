import { creditCorrectionBody, correctionImpactRows, draftCorrectionMessages } from './credit-correction'
import { contractSetupBody } from './contract-setup'
import { pricingSimulationBody } from './pricing-simulation'
// Proposals (agent-prepared work awaiting a person), the Stripe move-in kit
// (preview, apply, undo, shadow comparison and cutover) and exports.
import type { Bindings } from '../../auth.server'
import { requireCapability, canRead, can, type Actor } from '../actor'
import { runs } from '../billruns'
import { business } from '../business'
import { formatDate, formatPeriod } from '../dates'
import type { Input } from '../input'
import { FILES, importJobs, previewImport, shadowSubscriptions, type Preview } from '../movein/stripe'
import { proposalDetail, proposals } from '../proposals'
import { area, cents, check, details, field, fileField, form, h, hidden, page, table, tag, when, who } from './html'
import { personName } from './shell'

const KIND_LABELS: Record<string, string> = { amendment: 'Contract terms', price_change: 'Price change', usage_correction: 'Usage correction', collection: 'Collections reminder' }

export async function proposalsPage(env: Bindings, actor: Actor, url: URL) {
  const rows = await proposals(env, actor)
  const zone = (await business(env))!.timezone
  return page('Proposals', actor, h`<h1>Proposals</h1><p class="hint">Work prepared by an agent or a colleague. Nectar recomputes every amount itself; nothing changes until a person approves, and a proposal whose records moved since it was prepared cannot be approved.</p>
    <section class="card">${table(['Proposal', 'Kind', 'Prepared by', 'When', 'Status'], rows.map((p: any) => [h`<a href="/app/proposals/${p.id}">${p.title}</a>`, p.invoice_credit?'Invoice credit correction':KIND_LABELS[p.kind], personName(actor, p.created_by), when(p.created_at, zone), tag(p.status === 'pending' ? 'Pending' : p.status === 'approved' ? 'Approved' : 'Rejected')]), { empty: 'No proposals. An agent with a "prepare" credential posts them to /api/nectar/proposal.create.', lead: true })}</section>`, { current: '/app/proposals', url })
}

const impactRows = (periods: any[]) => table(['Period', 'Before$', 'After$', 'Difference$'], periods.map((p: any) => [formatPeriod(p.period.start, p.period.end), cents(p.before.subtotalCents), cents(p.after.subtotalCents), cents(p.after.subtotalCents - p.before.subtotalCents)]))

export async function proposalPage(env: Bindings, actor: Actor, id: string, url: URL) {
  const p = await proposalDetail(env, actor, id)
  const zone = (await business(env))!.timezone
  const decider = p.status === 'pending' && actor.kind === 'member' && can(actor, 'approve')
  const evidence = p.evidence as any, impact = p.impact as any, payload = p.payload as any
  const body = payload.setup ? contractSetupBody(p,actor) : payload.invoice_credit ? creditCorrectionBody(p) : p.kind === 'amendment' ? h`<p>Proposed: ${payload.kind === 'discount_percent' ? `${payload.value}% discount` : payload.kind === 'fixed_credit' ? `$${payload.value} one-time credit` : `contract price $${payload.value}`} from ${formatDate(payload.effective_from)}${payload.effective_to ? ` until ${formatDate(payload.effective_to)}` : ''} on <a href="/app/subscriptions/${payload.subscription}">the subscription</a>.</p>
      <h3>Quoted clauses</h3><ul class="quotes">${(evidence.clauses ?? []).map((c: any) => h`<li><blockquote>${c.quote}</blockquote>${c.reference ? h`<span class="sub">${c.reference}</span>` : ''}</li>`)}</ul>
      ${evidence.ambiguities?.length ? h`<h3>Flagged ambiguities</h3><ul class="flags">${evidence.ambiguities.map((a: string) => h`<li>${a}</li>`)}</ul>` : ''}
      <h3>Effect on invoices (computed by Nectar)</h3>${correctionImpactRows(impact)}`
    : p.kind === 'price_change' && payload.simulation ? pricingSimulationBody(impact)
    : p.kind === 'price_change' ? h`<p>${payload.target_price ? 'Move to the selected catalogue price' : `New ${payload.kind} price $${payload.unit_amount}`} ${payload.timing === 'renewal' ? 'at each subscription’s first renewal on or after' : 'from'} ${formatDate(payload.effective_date)} for ${impact.length} subscription(s). Unselected subscriptions retain their existing prices.</p>
      ${impact.map((s: any) => h`<h3><a href="/app/subscriptions/${s.subscription}">${s.customer} — ${s.subscriptionLabel ?? s.subscription}</a> (× ${s.quantity})</h3><p>Effective ${formatDate(s.effective_date ?? payload.effective_date)}</p>${impactRows(s.periods)}`)}`
    : p.kind === 'usage_correction' ? h`<h3>Corrections</h3>${table(['Action', 'Event', 'Quantity$', 'Occurred', 'Reason'], impact.rows.map((r: any) => [r.action === 'void' ? 'Void' : 'Add', r.event, r.quantity, r.occurredAt, r.reason]))}
      ${impact.invoices.length ? h`<h3>Effect on invoices (computed by Nectar)</h3>${impact.invoices.map((s: any) => h`<h4>${s.customer}</h4>${correctionImpactRows([s])}`)}` : ''}
      <h3>Sources</h3><ul>${(evidence.sources ?? []).map((s: string) => h`<li>${s}</li>`)}</ul>${payload.run ? h`<p class="hint">Approving re-prepares the draft bill run; its invoices still need their own approval.</p>` : ''}`
    : h`<p>Overdue: ${cents(impact.balanceCents)} across ${impact.overdue.length} invoice(s).</p>`
  const decide = !decider ? '' : (p.stale || payload.setup && impact.unresolvedAmbiguities?.length) ? h`<p class="flash error" role="alert">${p.stale?'The records changed after this was prepared. Reject it and ask for a new proposal.':'Resolve the setup ambiguities in a new proposal before approval.'}</p>${form('proposal.decide', `/app/proposals/${p.id}`, h`${hidden('proposal', p.id)}${hidden('decision', 'rejected')}`, 'Reject', { secondary: true })}`
    : h`${p.needsCreditPreparation ? h`<p>A human must prepare this exact above-limit credit before a different approver decides it.</p>${form('proposal.credit.prepare',`/app/proposals/${p.id}`,h`${hidden('proposal',p.id)}`,'Prepare governed credit request')}` : p.needsPreparation ? h`<p class="hint">This older price proposal has no saved preparer identity. Reject it and prepare a new proposal.</p>` : p.needsOtherApprover ? h`<p class="hint">Another approver must approve this ${payload.invoice_credit?'credit':payload.setup?'setup':'price change'}. You prepared it.</p>` : form('proposal.decide', `/app/proposals/${p.id}`, h`${hidden('proposal', p.id)}${hidden('decision', 'approved')}${p.kind === 'collection' ? h`${field('To', 'recipient', { type: 'email', value: payload.recipient })}${field('Subject', 'subject', { value: payload.subject })}${area('Message', 'body', payload.body, true, 10)}` : ''}${field('Note (optional)', 'note', { required: false })}`, p.kind === 'collection' ? 'Approve recipient and wording' : 'Approve', { primary: true })}
       ${form('proposal.decide', `/app/proposals/${p.id}`, h`${hidden('proposal', p.id)}${hidden('decision', 'rejected')}${field('Why not (optional)', 'note', { required: false })}`, 'Reject', { secondary: true })}`
  return page(p.title, actor, h`<p class="crumbs"><a href="/app/proposals">Proposals</a></p><div class="title-row"><h1>${p.title}</h1>${tag(p.status === 'pending' ? (p.stale ? 'Stale' : 'Pending') : p.status === 'approved' ? 'Approved' : 'Rejected')}</div>
    <p class="sub">${payload.invoice_credit?'Invoice credit correction':KIND_LABELS[p.kind]} · prepared by ${who(actor, p.created_by)} · ${when(p.created_at, zone)}${p.decided_by ? h` · decided by ${who(actor, p.decided_by)}` : ''}</p>
    <section class="card">${body}</section>${draftCorrectionMessages(p)}${decide ? h`<section class="card" aria-labelledby="decide"><h2 id="decide">Decide</h2>${decide}</section>` : ''}
    ${details({ Proposal: p.id, Payload: payload, Basis: p.basis, Result: p.result ?? '—', 'Decision note': p.decision_note ?? '—' })}`, { current: '/app/proposals', url })
}

const uploadFields = () => h`${fileField('Manifest (manifest.json)', 'manifest', { required: true, accept: '.json', hint: 'Lists each captured file with its object count and has_more: false.' })}
  ${fileField('Customers (GET /v1/customers)', 'customers', { required: true, accept: '.json' })}${fileField('Products (GET /v1/products)', 'products', { required: true, accept: '.json' })}
  ${fileField('Prices (GET /v1/prices)', 'prices', { required: true, accept: '.json' })}${fileField('Subscriptions (GET /v1/subscriptions?status=all)', 'subscriptions', { required: true, accept: '.json' })}
  ${fileField('Invoices (GET /v1/invoices), for shadow comparison', 'invoices', { accept: '.json' })}${fileField('Credit notes (GET /v1/credit_notes), optional numbered history', 'credit_notes', { accept: '.json' })}${fileField('Billing meters (GET /v1/billing/meters), for metered prices', 'meters', { accept: '.json' })}${fileField('Payments (GET /v1/charges), read-only history', 'payments', { accept: '.json' })}${fileField('Refunds (GET /v1/refunds), read-only history', 'refunds', { accept: '.json' })}${fileField('Disputes (GET /v1/disputes), read-only history', 'disputes', { accept: '.json' })}${fileField('Subscription events (GET /v1/events), read-only history', 'subscription_events', { accept: '.json' })}`

export async function importPage(env: Bindings, actor: Actor, url: URL) {
  const jobs = await importJobs(env, actor)
  const shadow = await shadowSubscriptions(env, actor)
  const owner = actor.role === 'owner'
  const zone = (await business(env))!.timezone
  return page('Move in', actor, h`<h1>Move in from Stripe Billing</h1><p><a href="/app/import/investigations">Review move-in investigations</a></p>
    <section class="card" aria-labelledby="upload"><h2 id="upload">1. Preview</h2><p class="hint">Upload the Stripe API list responses you captured (expanded with <code>data.items</code> and <code>data.discounts</code> where present). The preview writes nothing.</p>
      <form method="post" action="/app/import/preview" enctype="multipart/form-data" class="columns">${uploadFields()}<button type="submit">Preview the move</button></form></section>
    <section class="card" aria-labelledby="jobs"><h2 id="jobs">2. Moves applied</h2>${table(['Applied', 'State', 'Records$', 'Originals', 'Undo'], jobs.map((j: any) => [when(j.appliedAt, zone), tag(j.state === 'completed' ? 'Completed' : j.state), j.effects,h`${(j.originalFiles??[]).map((file:any)=>file.available?h`<p><a href="/app/import/${j.id}/originals/${file.id}">Download ${file.name}</a></p>`:h`<p>${file.name}: withdrawn</p>`)}`,
      j.state === 'completed' ? (j.blockers.length ? h`<span class="sub">Blocked: ${j.blockers.length} record(s) were edited or billed since</span>` : form('import.job', '/app/import', h`${hidden('job', j.id)}${hidden('action', 'undo')}`, 'Undo this move', { secondary: true })) : '']), { empty: 'Nothing moved in yet.' })}</section>
    <section class="card" aria-labelledby="shadow"><h2 id="shadow">3. Shadow and cutover</h2><p class="hint">Moved-in subscriptions bill nothing. Prepare a bill run for a month Stripe already billed and compare. When it agrees, the owner adopts each subscription from a period Stripe has not billed, so no period is billed twice.</p>
      ${table(['Customer', 'Last period Stripe billed', 'Earliest cutover', 'Shadow comparison', ''], shadow.map((s: any) => [s.customer_name, formatDate(s.lastBilledPeriodStart), formatDate(s.earliestCutover), tag(s.reconciled ? 'Reconciled' : 'Not reconciled'),
        owner ? form('subscription.adopt', '/app/import', h`${hidden('subscription', s.id)}${field('Cutover period start', 'cutover_start', { type: 'date', value: s.earliestCutover })}${s.reconciled ? '' : check('Adopt even though no shadow period agrees', 'acknowledge_unreconciled')}`, 'Adopt', { layout: 'row-form' }) : '']), { empty: 'No subscriptions in shadow.' })}</section>`, { current: '/app/import', url })
}

export async function previewPage(env: Bindings, actor: Actor, input: Input, url: URL) {
  let preview: Preview
  try { preview = await previewImport(env, actor, input) } catch (error: any) {
    const detail = error?.detail ? JSON.stringify(error.detail) : ''
    return page('Move in', actor, h`<h1>Move in from Stripe Billing</h1><p class="flash error" role="alert">That did not work: ${String(error?.code ?? error?.message ?? 'error').replace(/_/g, ' ')}. ${detail}</p><p><a class="button" href="/app/import">Back</a></p>`, { current: '/app/import', url, status: error?.status ?? 400 })
  }
  return page('Move-in preview', actor, h`<h1>Move-in preview</h1>
    <section class="card summary"><dl class="figures">${Object.entries(preview.create).map(([kind, n]) => h`<div><dt>New ${kind.replaceAll('_',' ')}s</dt><dd>${n}</dd></div>`)}<div><dt>Rejected</dt><dd>${preview.rejected.length}</dd></div></dl></section>
    <section class="card"><h2>Capture coverage</h2>${table(['File', 'Manifest count$', 'Found$', 'Complete'], preview.coverage.map(c => [c.file, c.manifest ?? '—', c.found, tag(c.complete ? 'Reconciled' : 'Not reconciled')]))}</section>
    ${preview.rejected.length ? h`<section class="card"><h2>Not moved</h2>${table(['Record', 'Reason'], preview.rejected.map(r => [r.location, r.reason]))}</section>` : ''}
    ${preview.attention.length ? h`<section class="card"><h2>Check after the move</h2>${table(['Record', 'Note'], preview.attention.map(r => [r.location, r.reason]))}</section>` : ''}
    <section class="card"><h2>Before you apply</h2><ul>${preview.gaps.map(g => h`<li>${g}</li>`)}</ul>
      <form method="post" action="/app/do/import.apply">${hidden('returnTo', '/app/import')}${hidden('fingerprint', preview.fingerprint)}${FILES.filter(name => preview.carry[`${name}_b64`]).map(name => h`${hidden(`${name}_b64`, preview.carry[`${name}_b64`])}${hidden(`${name}_name`, preview.carry[`${name}_name`])}`)}<button type="submit">Apply this exact move</button></form>
      ${details({ Fingerprint: preview.fingerprint, Counts: preview.counts })}</section>`, { current: '/app/import', url })
}

export async function exportsPage(env: Bindings, actor: Actor, url: URL) {
  // GOV-001: exporting covers only what the role can read; bill runs need full read.
  requireCapability(actor, 'export')
  const list = can(actor, 'read') ? (await runs(env, actor)).filter((r: any) => r.status === 'finalised' || r.status === 'draft') : []
  return page('Exports', actor, h`<h1>Exports</h1>${canRead(actor, 'invoices') ? h`<p><a href="/app/exports/number-register.csv">Invoice and credit-note number register with gap report (CSV)</a></p>` : ''}<p><a href="/app/metadata">Browse, filter and export object metadata</a></p>
    <section class="card"><h2>Records</h2><ul class="downloads">${canRead(actor, 'customers') ? h`<li><a class="download" href="/app/exports/customers.csv">Customers and notes (CSV)</a> — billing details, append-only notes and retained source history.</li>` : ''}${canRead(actor, 'invoices') ? h`<li><a class="download" href="/app/exports/invoices.csv">Issued invoices (CSV)</a> — totals, credits, payments and balance, with each invoice's calculation fingerprint.</li>` : ''}${can(actor, 'read') ? h`<li><a class="download" href="/app/exports/usage.csv">Usage events (CSV)</a> — every event, its status and the invoice that billed it.</li>` : ''}${canRead(actor, 'subscriptions') ? h`<li><a class="download" href="/app/exports/subscriptions.csv">Subscriptions (CSV)</a> — plans, quantities, dates and cutovers.</li>` : ''}</ul></section>
    ${can(actor, 'read') ? h`<section class="card"><h2>Bill runs</h2>${table(['Month', 'Status', ''], list.map((r: any) => [r.period, tag(r.status === 'finalised' ? 'Finalized' : 'Draft'), h`<a class="download" href="/app/billing/${r.id}.json">Bill run with calculation evidence (JSON)</a>`]), { empty: 'No bill runs yet.' })}</section>` : ''}
    <section class="card"><h2>Complete restore package</h2><p>The whole installation — every record, approval, calculation and the audit trail — exports as one archive from the computer that runs Nectar:</p><pre class="message">rer export --output nectar.rer</pre><p class="hint">Restore it into a fresh installation with <code>rer import --input nectar.rer --yes</code>. Sign-in accounts are not part of the archive; the owner signs in again.</p></section>`, { current: '/app/exports', url })
}
