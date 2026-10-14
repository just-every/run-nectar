// Nectar's public doors: /app pages, /app/do/ACTION form posts, /api/nectar
// JSON (a member's session, or a scoped credential sent as a bearer key), and
// access-checked downloads. Every request resolves its actor first; nothing
// private is served to a signed-out request.
import { runtimeBindings, type Bindings } from '../auth.server'
import { AuthError, safeReturnTo } from '../modules/operator-auth/index.mjs'
import { actions } from './actions'
import { currentActor, type Actor } from './actor'
import { NectarError } from './core'
import { business } from './business'
import { Input } from './input'
import { PAGE_DOORS, match } from './doors'
import { route } from './views'
import { h, page } from './ui/html'
import { pages, postPages } from './ui/pages'

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })

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

async function apiResponse(env: Bindings, actor: Actor, request: Request, url: URL) {
  const path = url.pathname.slice('/api/nectar/'.length)
  if (request.method === 'POST') {
    const action = actions[path]
    if (!action) throw new NectarError('not_found', 404)
    return json(await action(env, actor, await Input.from(request), request))
  }
  const { view, id } = route(path)
  return json(await view(env, actor, request, id, url))
}

async function pageResponse(env: Bindings, actor: Actor, request: Request, url: URL): Promise<Response> {
  const path = url.pathname
  if (request.method === 'POST') {
    const special = postPages[path]
    if (special) return await special(env, actor, await Input.from(request), url, request)
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
  if (!await business(env) && path !== '/app/settings') {
    if (actor.role === 'owner') return Response.redirect(`${env.AUTH_ORIGIN}/app/settings`, 303)
    return page('Not ready', actor, h`<div class="first-run"><h1>Nectar is not set up yet</h1><p>The owner needs to enter the business's billing details first.</p></div>`, { showNav: false })
  }
  const found = match(PAGE_DOORS, path)
  if (!found) throw new NectarError('not_found', 404)
  return await pages[found.name](env, actor, request, url, found.id)
}

function redirect(env: Bindings, target: string, key: 'notice' | 'error', value: string) {
  const location = new URL(target, env.AUTH_ORIGIN)
  location.searchParams.set(key, value)
  return new Response(null, { status: 303, headers: { location: location.pathname + location.search, 'cache-control': 'no-store' } })
}
