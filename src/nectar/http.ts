// Nectar's public doors: /app pages, /app/do/ACTION form posts, /api/nectar
// JSON (a member's session, or a scoped credential sent as a bearer key), and
// access-checked downloads. Every request resolves its actor first; nothing
// private is served to a signed-out request.
import { runtimeBindings, type Bindings } from '../auth.server'
import { AuthError, safeReturnTo } from '../modules/operator-auth/index.mjs'
import { actions } from './actions'
import { currentActor,requireCapability, type Actor } from './actor'
import { NectarError,insist,one } from './core'
import { business } from './business'
import { Input } from './input'
import { LIST_DOORS, PAGE_DOORS, match } from './doors'
import { present, requestVersion } from './api-versions'
import { idempotent } from './idempotency'
import { paged } from './list-cursor'
import { route } from './views'
import { h, page } from './ui/html'
import { pages, postPages } from './ui/pages'
import { loadShell } from './ui/shell'
import { SELF_SERVICE, mfaHold } from './mfa'

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers } })

export function failure(error: unknown): { code: string; status: number; detail?: unknown } {
  if (error instanceof NectarError) return { code: error.code, status: error.status, detail: error.detail }
  if (error instanceof AuthError) return { code: error.code, status: error.status }
  const code = error instanceof Error ? error.message : ''
  if (/^(IMPORT_|PROVENANCE_|TARGET_|NATIVE_EDIT_CONFLICT|REVERSAL_|UNDO_|SOURCE_|DUPLICATE_)/.test(code)) return { code: code.split(/[:\s]/)[0].toLowerCase(), status: 409 }
  console.error('nectar_internal_error', error)
  return { code: 'internal_error', status: 500 }
}

// A refusal answered before the body is read still reads (and drops) the body,
// so the connection is never reset under a waiting client.
async function drained(request: Request, response: Response) {
  if (request.body && !request.bodyUsed) await request.arrayBuffer().catch(() => null)
  return response
}

export async function nectarResponse(request: Request, original: Bindings): Promise<Response | null> {
  const env = runtimeBindings(original)
  const url = new URL(request.url)
  const api = url.pathname.startsWith('/api/nectar/')
  if (!api && url.pathname !== '/app' && !url.pathname.startsWith('/app/')) return null
  if (!['GET', 'HEAD', 'POST'].includes(request.method)) return new Response(null, { status: 405, headers: { allow: 'GET, HEAD, POST' } })
  const bearer = api && request.headers.has('authorization')
  // Cookie-authenticated posts must come from this origin; a bearer key carries no ambient cookie.
  if (request.method === 'POST' && !bearer && request.headers.get('origin') !== env.AUTH_ORIGIN) return await drained(request, api ? json({ error: 'invalid_origin' }, 403) : new Response('Forbidden', { status: 403 }))
  if (!api && request.headers.has('authorization')) return await drained(request, new Response('Forbidden', { status: 403 }))
  let actor: Actor | null = null
  try {
    actor = await currentActor(env, request)
    if (!actor) return await drained(request, api ? json({ error: 'authentication_required' }, 401) : Response.redirect(`${env.AUTH_ORIGIN}/signin?returnTo=${encodeURIComponent(url.pathname)}`, 303))
    // GOV-007: a member whose role requires a second factor reaches nothing but
    // their own enrollment and check until a factor is enrolled and presented.
    const held = await mfaHold(env, actor)
    if (held && !heldMayUse(request, url, api)) {
      if (api) return await drained(request, json({ error: held.code, ...(held.reason ? { detail: { reason: held.reason } } : {}) }, 403))
      const back = request.method === 'POST' ? `error=${held.code}` : `returnTo=${encodeURIComponent(url.pathname)}`
      return await drained(request, new Response(null, { status: 303, headers: { location: `/app/security?${back}`, 'cache-control': 'no-store' } }))
    }
    if (api) return await apiResponse(env, actor, request, url)
    return await pageResponse(env, actor, request, url)
  } catch (error) {
    const { code, status, detail } = failure(error)
    if (request.body && !request.bodyUsed) await request.arrayBuffer().catch(() => null)
    if (api) return json({ error: code, ...(detail === undefined ? {} : { detail }) }, status)
    if (status === 404) return page('Not found', actor, h`<h1>Not found</h1><p>There is nothing here you can open.</p><p><a class="button" href="/app">Back to your work</a></p>`, { status: 404 })
    return page('Something went wrong', actor, h`<h1>That did not work</h1><p>${code.replace(/_/g, ' ')}</p><p><a class="button" href="/app">Back to your work</a></p>`, { status })
  }
}

function heldMayUse(request: Request, url: URL, api: boolean) {
  const path = url.pathname
  if (api) return request.method === 'POST' ? SELF_SERVICE.includes(path.slice('/api/nectar/'.length)) : path === '/api/nectar/mfa'
  if (request.method !== 'POST') return path === '/app/security' || path === '/app/security/passkey.js'
  return ['/app/security/totp', '/app/security/confirm', '/app/security/verify'].includes(path) || SELF_SERVICE.includes(path.replace(/^\/app\/do\//, ''))
}

// DEV-002: every JSON answer is shaped by the request's dated version, and a
// write carrying an Idempotency-Key runs at most once per key.
async function apiResponse(env: Bindings, actor: Actor, request: Request, url: URL) {
  const path = url.pathname.slice('/api/nectar/'.length)
  const version = requestVersion(actor, request)
  const send = (body: unknown, extra: Record<string, string> = {}) => json(present(version, body), 200, { 'nectar-version': version, ...extra })
  if (request.method === 'POST') {
    const action = actions[path]
    if (!action) throw new NectarError('not_found', 404)
    const key = request.headers.get('idempotency-key')
    if (key === null) return send(await action(env, actor, await Input.from(request), request))
    const stored = await idempotent(env, actor, request, key, `${path}\n${version}`, async () => await action(env, actor, await Input.from(request), request))
    return send(stored.body, stored.replayed ? { 'idempotent-replayed': 'true' } : {})
  }
  const { name, view, id } = route(path)
  insist(name === 'invoices' || LIST_DOORS.includes(name) || (!url.searchParams.has('limit') && !url.searchParams.has('cursor')), 'not_a_list')
  if (/^(subscriptions\/|proposals\/|invoices\/[^/]+\/lines\/)/.test(path)) requireCapability(actor,'read')
  if (/^(subscriptions\/|proposals\/|invoices\/[^/]+\/lines\/)/.test(path) && await one(env,'SELECT 1 FROM nc_erased_records WHERE record_id=?',id.split('/')[0])) throw new NectarError('customer_erased',410)
  const result=await view(env, actor, request, id, url)
  return result instanceof Response ? result : send(LIST_DOORS.includes(name) ? paged(result, url, path) : result)
}

async function pageResponse(env: Bindings, actor: Actor, request: Request, url: URL): Promise<Response> {
  const path = url.pathname
  if (request.method === 'POST') {
    const special = postPages[path]
    if (special) {
      await loadShell(env, actor)
      return await special(env, actor, await Input.from(request), url, request)
    }
    const name = path.match(/^\/app\/do\/([\w.]+)$/)?.[1]
    const action = name ? actions[name] : undefined
    if (!action) throw new NectarError('not_found', 404)
    const input = await Input.from(request)
    const returnTo = safeReturnTo(input.text('returnTo', { optional: true, max: 300 }) || '/app', '/app')
    try {
      const result = await action(env, actor, input, request) as { id?: string } | null
      return redirect(env, returnTo.replace('{id}', encodeURIComponent(result?.id ?? '')), 'notice', 'Saved.')
    } catch (error) {
      const { code, status } = failure(error)
      if (status >= 500) throw error
      return redirect(env, returnTo.replace('/{id}', ''), 'error', code)
    }
  }
  // The owner sets up the business before anything else.
  if (!await business(env) && path !== '/app/settings' && !path.startsWith('/app/security')) {
    if (actor.role === 'owner') return Response.redirect(`${env.AUTH_ORIGIN}/app/settings`, 303)
    return page('Not ready', actor, h`<div class="first-run"><h1>Nectar is not set up yet</h1><p>The owner needs to enter the business's billing details first.</p></div>`, { showNav: false })
  }
  const found = match(PAGE_DOORS, path)
  await loadShell(env, actor)
  if (!found) throw new NectarError('not_found', 404)
  if (['subscription','upcoming','proposal','setupSource','certificateFile','reportLine'].includes(found.name) && await one(env,'SELECT 1 FROM nc_erased_records WHERE record_id=?',found.id.split('/')[0])) return page('Personal data erased',actor,h`<h1>Personal data erased</h1><p>This source was withdrawn by an approved erasure. Required financial figures remain on their invoice until the retention date.</p><p><a href="/app/erasures">Erasure requests and receipts</a></p>`,{status:410})
  return await pages[found.name](env, actor, request, url, found.id)
}

function redirect(env: Bindings, target: string, key: 'notice' | 'error', value: string) {
  const location = new URL(target, env.AUTH_ORIGIN)
  location.searchParams.set(key, value)
  return new Response(null, { status: 303, headers: { location: location.pathname + location.search, 'cache-control': 'no-store' } })
}
