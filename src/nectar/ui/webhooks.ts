import type { Bindings } from '../../auth.server'
import {can,type Actor} from '../actor'
import { webhookList,webhookDetail } from '../webhooks'
import { check,field,form,h,hidden,page,table } from './html'

// Existing Nectar forms and tables; the application's visual design stays
// with the shared frame. Secrets appear only on the direct POST result.
export async function webhooksPage(env: Bindings, actor: Actor, url: URL, issued?: {id:string;secret:string}) {
  const {endpoints,deliveries}=await webhookList(env,actor)
  return page('Outbound webhooks',actor,h`<h1>Outbound webhooks</h1>
  <p>Send billing events to your application's HTTPS receiver. Delivery is at least once: deduplicate the event id. Retries continue for three days. Response bodies are discarded.</p>
  ${issued?h`<section class="card"><h2>Save this signing secret</h2><p>Shown once. Store it in your receiver's secret manager.</p><p><code class="secret">${issued.secret}</code></p></section>`:''}
  <section class="card"><h2>Registered endpoints</h2>${endpoints.map(e=>h`<article><h3>${new URL(e.url).hostname}</h3><p>${e.enabled?'Active':'Disabled'} · revision ${e.revision}</p>${e.enabled?h`<form method="post" action="/app/webhooks/rotate">${h`${hidden('endpoint',e.id)}${hidden('revision',e.revision)}${field('Old-secret overlap (seconds, 0–86400)','overlap_seconds',{type:'number',value:3600})}`}<button type="submit">Rotate signing secret</button></form>${form('webhook.disable','/app/webhooks',hidden('endpoint',e.id),'Disable endpoint',{secondary:true})}`:''}</article>`)}
  <h3>Register an endpoint</h3><form method="post" action="/app/webhooks/register">${field('HTTPS receiver URL','url',{type:'url'})}${check('I authorize sending typed billing identifiers, amounts and event-time metadata to this endpoint.','consent')}<button type="submit">Register endpoint</button></form></section>
  <section class="card"><h2>Delivery log</h2>${form('webhook.dispatch','/app/webhooks','','Send due deliveries',{secondary:true})}${table(['Event','Outcome','Attempts','HTTP'],deliveries.map(d=>[h`<a href="/app/webhooks/${d.id}">${d.type}</a>`,d.status,d.attempts,d.http_status??'No response']),{empty:'No events queued. New events are captured after registration.'})}</section>`,{url,current:'/app/more'})
}
export async function webhookDeliveryPage(env: Bindings, actor: Actor, id: string, url: URL) {
  const d=await webhookDetail(env,actor,id)
  return page('Webhook delivery',actor,h`<h1>Webhook delivery</h1><p>${d.type} · ${d.status}</p><p>Event <code>${d.event_id}</code></p>
  <section class="card"><h2>Attempts</h2>${table(['Attempt','Outcome','HTTP'],d.attempts.map(a=>[a.attempt,a.status,a.http_status??'No response']))}
  ${can(actor,'credentials')?form('webhook.replay',`/app/webhooks/${id}`,hidden('delivery',id),'Replay original event',{secondary:true}):''}</section>
  ${can(actor,'credentials')?h`<p><a href="/app/webhooks">All outbound webhooks</a></p>`:''}`,{url,current:'/app/more'})
}
