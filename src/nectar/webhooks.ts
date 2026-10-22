// Outbound webhooks: explicit owner consent, immutable snapshots and durable
// at-least-once delivery. A receiver must deduplicate the stable event id.
import type { Bindings } from '../auth.server'
import { actorLabel, requireOwner, type Actor } from './actor'
import { all, commit, guard, insist, newId, one, stmt } from './core'
import { clockInstant } from './clock'
import type { Input } from './input'
import { requireFreshFactor } from './mfa'
import { b64url, seal, unseal } from './mfa-crypto'
import { alertStatements } from './notifications'
import { deliverAlerts } from './notification-mail'

export function webhookUrl(value: string) {
  let url: URL
  try { url = new URL(value) } catch { insist(false,'invalid_webhook_url') }
  // Do not follow redirects or accept IP literals, local names, credentials,
  // custom ports or fragments. Outbound hosts are explicit audited consent.
  const host=url.hostname.toLowerCase()
  insist(url.protocol==='https:' && !url.username && !url.password && !url.port && !url.hash && host.length<=253 &&
    /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/.test(host) && !/(?:^|\.)(localhost|local|internal|test|invalid|example|onion)$/.test(host) &&
    !host.endsWith('.localhost') && host!=='metadata.google.internal','invalid_webhook_url')
  return url.href
}
const endpointSelect='id,url,enabled,overlap_until,created_by,created_at,revision'
export async function webhookList(env: Bindings, actor: Actor) {
  requireOwner(actor)
  return { endpoints:await all(env,`SELECT ${endpointSelect} FROM nc_webhook_endpoints ORDER BY created_at,id`), deliveries:await all(env,
    `SELECT d.*,e.type,e.subject FROM nc_webhook_deliveries d JOIN nc_webhook_events e ON e.id=d.event_id ORDER BY d.updated_at DESC,d.id LIMIT 100`) }
}
export async function webhookDetail(env: Bindings, actor: Actor, id: string) {
  insist(actor.kind==='member'&&(actor.role==='owner'||actor.role==='finance'),'forbidden',403)
  const delivery=await one(env,'SELECT * FROM nc_webhook_deliveries WHERE id=?',id)
  insist(delivery,'delivery_not_found',404)
  if(actor.role!=='owner')return {id:delivery.id,event_id:delivery.event_id,status:delivery.status,type:(await one(env,'SELECT type FROM nc_webhook_events WHERE id=?',delivery.event_id))!.type,attempts:await all(env,'SELECT attempt,status,http_status,at FROM nc_webhook_attempts WHERE delivery_id=? ORDER BY attempt',id)}
  return { ...delivery,type:(await one(env,'SELECT type FROM nc_webhook_events WHERE id=?',delivery.event_id))!.type,event:await one(env,'SELECT id,type,subject,payload_json,created_at FROM nc_webhook_events WHERE id=?',delivery.event_id),attempts:await all(env,'SELECT attempt,status,http_status,at FROM nc_webhook_attempts WHERE delivery_id=? ORDER BY attempt',id) }
}
export async function registerWebhook(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor);await requireFreshFactor(env,actor)
  input.only(['url','consent','returnTo'])
  insist(input.flag('consent'),'webhook_consent_required')
  insist(env.MFA_KEY,'mfa_key_missing',409)
  const url=webhookUrl(input.text('url',{max:1000})),id=newId(),at=clockInstant(env),secret=b64url(crypto.getRandomValues(new Uint8Array(32)))
  insist((await one<{n:number}>(env,'SELECT COUNT(*) n FROM nc_webhook_endpoints'))!.n<20,'endpoint_limit',409)
  await commit(env,[stmt(env,'INSERT INTO nc_webhook_endpoints(id,url,secret_sealed,created_by,created_at) VALUES(?,?,?,?,?)',id,url,await seal(env.MFA_KEY,new TextEncoder().encode(secret),`webhook:${id}`),actorLabel(actor),at)],
    {actor:actorLabel(actor),action:'webhook.register',subject:id,detail:{url,consent:true,payload:'typed identifiers,amounts and event-time metadata'}})
  return {id,url,secret}
}
export async function rotateWebhook(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor);await requireFreshFactor(env,actor)
  input.only(['endpoint','revision','overlap_seconds','returnTo'])
  insist(env.MFA_KEY,'mfa_key_missing',409)
  const id=input.text('endpoint'),revision=input.integer('revision',{min:1}),seconds=input.integer('overlap_seconds',{min:0,max:86400})!
  const row=await one(env,'SELECT * FROM nc_webhook_endpoints WHERE id=?',id);insist(row,'endpoint_not_found',404)
  const at=clockInstant(env),secret=b64url(crypto.getRandomValues(new Uint8Array(32)))
  await commit(env,[guard(env,'stale','EXISTS(SELECT 1 FROM nc_webhook_endpoints WHERE id=? AND revision=?)',id,revision),stmt(env,'UPDATE nc_webhook_endpoints SET previous_sealed=secret_sealed,secret_sealed=?,overlap_until=?,revision=revision+1 WHERE id=?',await seal(env.MFA_KEY,new TextEncoder().encode(secret),`webhook:${id}`),at+seconds*1000,id)],
    {actor:actorLabel(actor),action:'webhook.rotate',subject:id,detail:{overlap_until:at+seconds*1000}})
  return {id,secret,overlap_until:at+seconds*1000}
}
export async function disableWebhook(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor);await requireFreshFactor(env,actor)
  input.only(['endpoint','returnTo'])
  const id=input.text('endpoint')
  await commit(env,[guard(env,'stale','EXISTS(SELECT 1 FROM nc_webhook_endpoints WHERE id=? AND enabled=1)',id),stmt(env,'UPDATE nc_webhook_endpoints SET enabled=0,revision=revision+1,previous_sealed=NULL,overlap_until=NULL WHERE id=?',id),stmt(env,"UPDATE nc_webhook_deliveries SET status='suppressed',claim=NULL WHERE endpoint_id=? AND status<>'delivered'",id)],{actor:actorLabel(actor),action:'webhook.disable',subject:id})
  return {id,enabled:false}
}
export async function replayWebhook(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor);await requireFreshFactor(env,actor)
  input.only(['delivery','returnTo'])
  const id=input.text('delivery'),at=clockInstant(env)
  await commit(env,[guard(env,'not_replayable',`EXISTS(SELECT 1 FROM nc_webhook_deliveries d JOIN nc_webhook_endpoints p ON p.id=d.endpoint_id LEFT JOIN nc_customers c ON c.id=d.customer_id WHERE d.id=? AND d.status<>'sending' AND p.enabled=1 AND c.erased_at IS NULL AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id=d.event_id))`,id),stmt(env,"UPDATE nc_webhook_deliveries SET status='pending',next_at=?,deadline=?,updated_at=? WHERE id=?",at,at+259200000,at,id)],{actor:actorLabel(actor),action:'webhook.replay',subject:id})
  return {id}
}
async function signature(secret: Uint8Array, timestamp: number, body: string) {
  const key=await crypto.subtle.importKey('raw',secret as BufferSource,{name:'HMAC',hash:'SHA-256'},false,['sign'])
  return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${timestamp}.${body}`)))].map(v=>v.toString(16).padStart(2,'0')).join('')
}
const delays=[60000,300000,1800000,3600000,21600000,86400000]
export async function dispatchWebhooks(env: Bindings) {
  const at=clockInstant(env)
  await env.DB.prepare('UPDATE nc_webhook_endpoints SET previous_sealed=NULL,overlap_until=NULL WHERE overlap_until<=?').bind(at).run()
  const due=await all(env,`SELECT d.*,p.url,p.secret_sealed,p.previous_sealed,p.overlap_until,e.payload_json,e.type FROM nc_webhook_deliveries d JOIN nc_webhook_endpoints p ON p.id=d.endpoint_id JOIN nc_webhook_events e ON e.id=d.event_id LEFT JOIN nc_customers c ON c.id=d.customer_id WHERE p.enabled=1 AND c.erased_at IS NULL AND ((d.status='pending' AND d.next_at<=?) OR (d.status='sending' AND d.next_at<=?)) ORDER BY d.next_at,d.id LIMIT 50`,at,at)
  for(const d of due){
    const claim=newId(),attempt=d.attempts+1
    const taken=await env.DB.prepare("UPDATE nc_webhook_deliveries SET status='sending',claim=?,attempts=attempts+1,next_at=?,updated_at=? WHERE id=? AND attempts=? AND next_at<=? AND status IN ('pending','sending') RETURNING id").bind(claim,at+300000,at,d.id,d.attempts,at).first()
    if(!taken)continue
    let code:number|null=null,outcome='uncertain',ok=false
    try{
      const secret=await unseal(env.MFA_KEY,d.secret_sealed,`webhook:${d.endpoint_id}`)
      insist(secret,'webhook_key_unavailable',409)
      webhookUrl(d.url)
      const timestamp=Math.floor(at/1000),body=JSON.stringify({id:d.event_id,created_at:JSON.parse(d.payload_json).created_at??(await one(env,'SELECT created_at FROM nc_webhook_events WHERE id=?',d.event_id))!.created_at,...JSON.parse(d.payload_json)})
      const signatures=[await signature(secret,timestamp,body)]
      if(d.previous_sealed&&d.overlap_until>at){const previous=await unseal(env.MFA_KEY,d.previous_sealed,`webhook:${d.endpoint_id}`);if(previous)signatures.push(await signature(previous,timestamp,body))}
      const response=await fetch(d.url,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(10000),headers:{'content-type':'application/json','nectar-event-id':d.event_id,'nectar-signature':`t=${timestamp},${signatures.map(s=>`v1=${s}`).join(',')}`},body})
      code=response.status;ok=response.ok;outcome=ok?'accepted':'refused'
      await response.body?.cancel()
    }catch{outcome='uncertain'}
    const status=ok?'delivered':at>=d.deadline?'exhausted':'pending'
    const alerts=ok?[]:await alertStatements(env,'webhook_failure',d.id,`/app/webhooks/${d.id}`)
    await commit(env,[guard(env,'stale','EXISTS(SELECT 1 FROM nc_webhook_deliveries WHERE id=? AND claim=?)',d.id,claim),stmt(env,'INSERT INTO nc_webhook_attempts(id,delivery_id,customer_id,attempt,status,http_status,at) VALUES(?,?,?,?,?,?,?)',newId(),d.id,d.customer_id,attempt,outcome,code,at),stmt(env,'UPDATE nc_webhook_deliveries SET status=?,http_status=?,next_at=?,claim=NULL,updated_at=? WHERE id=?',status,code,Math.min(d.deadline,at+delays[Math.min(attempt-1,delays.length-1)]),at,d.id),...alerts],
      {actor:'system:webhooks',action:'webhook.delivery',subject:d.id,detail:{attempt,outcome,http_status:code}})
    if(!ok)await deliverAlerts(env,'webhook_failure',d.id,'system:webhooks')
  }
  return {processed:due.length}
}
export async function dispatchWebhookDoor(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor);input.only(['returnTo']);return await dispatchWebhooks(env)
}
