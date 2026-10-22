// DEV-001: webhook endpoints, their signing secrets, the delivery log, one
// delivery's attempts and payload, replay, and the published Stripe mapping.
import type { Bindings } from '../../auth.server'
import { can, type Actor } from '../actor'
import { business } from '../business'
import type { Row } from '../core'
import { EVENT_KINDS } from '../webhook-catalog'
import { webhookDeliveries, webhookDelivery, webhooksView } from '../webhooks'
import { checks, field, form, h, hidden, page, select, table, tag, when } from './html'

const manages = (actor: Actor) => actor.kind === 'member' && can(actor, 'credentials')
const replays = (actor: Actor) => actor.kind === 'member' && (can(actor, 'records') || can(actor, 'credentials'))
const kinds = EVENT_KINDS.filter(kind => kind.emitted).map(kind => ({ value: kind.kind, label: kind.kind }))
const outcome = (row: Row) => row.status === 'delivered' ? 'Delivered' : row.status === 'failed' ? 'Failed; retries ended' : row.attempts ? 'Retrying' : 'Waiting to send'
const lastAnswer = (row: Row) => row.last_outcome === 'http_error' ? `HTTP ${row.last_status}` : row.last_outcome === 'network_error' ? 'No answer' : row.last_outcome === 'no_signing_secret' ? 'No signing secret' : row.last_outcome === 'delivered' ? `HTTP ${row.last_status}` : '—'

const secretCard = (title: string, secret: string, note: string) => h`<section class="card key" aria-labelledby="new-secret"><h2 id="new-secret">${title}</h2>
  <p>Copy it now; Nectar shows a signing secret only once.</p><p><code class="secret">${secret}</code></p><p class="hint">${note}</p></section>`

export async function webhooksPage(env: Bindings, actor: Actor, url: URL, shown?: { title: string; secret: string; note: string }) {
  const view = await webhooksView(env, actor), zone = (await business(env))!.timezone
  const recent = (await webhookDeliveries(env, actor, new URL('/x', url))).slice(0, 50)
  const urlOf = new Map(view.endpoints.map(e => [e.id, e.url]))
  const endpoint = (e: Row) => h`<article class="card" aria-labelledby="endpoint-${e.id}"><h2 id="endpoint-${e.id}"><span class="mono">${e.url}</span></h2>
    <p>${tag(e.status === 'active' ? 'Active' : 'Disabled')} ${e.failing ? tag('Failing') : ''} ${e.description}</p>
    <p class="hint">Events: ${e.events.includes('*') ? 'every event' : e.events.join(', ')}. ${e.delivered} delivered, ${e.pending} waiting or retrying, ${e.failed} failed.</p>
    ${table(['Signing secret', 'Created', 'Signs'], e.secrets.map((s: Row) => [h`<span class="mono">${s.id.slice(0, 8)}</span>`, when(s.created_at, zone), s.signing ? (s.expires_at ? `Until ${when(s.expires_at, zone)}` : 'Yes') : 'No longer']))}
    ${manages(actor) ? h`${form('webhook.update', '/app/webhooks', h`${hidden('endpoint', e.id)}${hidden('revision', e.revision)}${select('Status', 'status', [{ value: 'active', label: 'Active' }, { value: 'disabled', label: 'Disabled' }], e.status)}${checks('Events', 'events', [{ value: '*', label: 'Every event' }, ...kinds], e.events)}`, 'Save endpoint', { layout: 'columns', secondary: true })}
      <form method="post" action="/app/webhooks/rotate" class="columns">${hidden('endpoint', e.id)}${field('Keep earlier secrets signing for (hours)', 'overlap_hours', { type: 'number', value: '24', hint: 'Both secrets sign every delivery until then, so your receiver can switch without missing one.' })}<button type="submit" class="secondary">Rotate secret</button></form>` : ''}</article>`
  return page('Webhooks', actor, h`<h1>Webhooks</h1>
    <p class="hint">Nectar posts each lifecycle event to your endpoints, signed with HMAC-SHA256 in the <code>Nectar-Signature</code> header (<code>t=</code> send time, <code>v1=</code> one signature per signing secret). A failed delivery retries after 1, 5 and 30 minutes, then hourly to twelve-hourly for more than three days. Payloads carry ids, states, dates, amounts and each record's metadata at event time; never names, email or postal addresses.</p>
    ${shown ? secretCard(shown.title, shown.secret, shown.note) : ''}
    ${view.endpoints.map(endpoint)}
    ${manages(actor) ? h`<section class="card" aria-labelledby="register"><h2 id="register">Register an endpoint</h2><form method="post" action="/app/webhooks/endpoint" class="columns">
      ${field('Endpoint URL', 'url', { type: 'url', hint: 'HTTPS on a public host name.' })}${field('Description', 'description', { required: false })}${checks('Events', 'events', [{ value: '*', label: 'Every event' }, ...kinds], ['*'])}<button type="submit">Register endpoint</button></form></section>` : ''}
    <section class="card" aria-labelledby="deliveries"><h2 id="deliveries">Recent deliveries</h2>
    ${table(['Event', 'Endpoint', 'Outcome', 'Attempts', 'Last answer', 'Next attempt'], recent.map(d => [h`<a href="/app/webhooks/deliveries/${d.id}">${d.event_type}</a>${d.replay_of ? ' (replay)' : ''}`, h`<span class="mono">${urlOf.get(d.endpoint_id) ?? d.endpoint_id}</span>`, tag(outcome(d)), d.attempts, lastAnswer(d), d.status === 'pending' ? when(d.next_attempt_at, zone) : '—']), { empty: 'No deliveries yet. Register an endpoint; each event from then on is delivered to it.' })}</section>
    <section class="card" aria-labelledby="events"><h2 id="events">Events and the Stripe Billing mapping</h2>
    ${table(['Event', 'Records', 'When'], view.events.map(e => [h`<span class="mono">${e.kind}</span>`, e.family, e.emitted ? e.about : h`${e.about} ${tag('Not yet sent')}`]))}
    <h3>Stripe Billing events an app consumes, and what Nectar sends</h3>
    ${table(['Stripe event', 'Nectar event', 'Note'], view.stripe_mapping.map(m => [h`<span class="mono">${m.stripe}</span>`, m.nectar ? h`<span class="mono">${m.nectar}</span>` : 'None', m.note]))}</section>`, { current: '/app/webhooks', url })
}

export async function webhookDeliveryPage(env: Bindings, actor: Actor, id: string, url: URL) {
  const d = await webhookDelivery(env, actor, id), zone = (await business(env))!.timezone
  return page('Webhook delivery', actor, h`<p><a href="/app/webhooks">Webhooks</a></p><h1>${d.event_type} to <span class="mono">${d.endpoint_url}</span></h1>
    <p>${tag(outcome(d))} ${d.replay_of ? h`Replay of <a href="/app/webhooks/deliveries/${d.replay_of}">an earlier delivery</a>.` : ''} ${d.status === 'pending' ? `Next attempt ${when(d.next_attempt_at, zone)}.` : d.delivered_at ? `Delivered ${when(d.delivered_at, zone)}.` : ''}</p>
    <section class="card" aria-labelledby="attempts"><h2 id="attempts">Attempts</h2>
    ${table(['Attempt', 'When', 'Answer', 'Took'], d.attempts.map((a: Row) => [a.attempt, when(a.at, zone), lastAnswer({ last_outcome: a.outcome, last_status: a.http_status }), `${a.duration_ms} ms`]), { empty: 'Not attempted yet.' })}
    ${replays(actor) && d.endpoint_status === 'active' ? form('webhook.replay', `/app/webhooks/deliveries/${d.id}`, hidden('delivery', d.id), 'Replay this event', { secondary: true }) : ''}
    ${d.replays.length ? h`<h3>Replays</h3>${table(['Delivery', 'Outcome', 'Attempts'], d.replays.map((r: Row) => [h`<a href="/app/webhooks/deliveries/${r.id}">${r.id}</a>`, tag(outcome(r)), r.attempts]))}` : ''}</section>
    <section class="card" aria-labelledby="payload"><h2 id="payload">Event <span class="mono">${d.event_id}</span></h2><p class="hint">Every attempt and replay posts these exact bytes.</p><pre class="mono">${JSON.stringify(d.payload, null, 2)}</pre></section>`, { current: '/app/webhooks', url })
}

export const webhookSecretNote = 'Verify it in your receiver: HMAC-SHA256 of "t.body" with this secret must equal one v1 value, and t must be recent.'
