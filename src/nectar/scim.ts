import type { Bindings } from '../auth.server'
import { all, commit, guard, insist, newId, now, one, sha256Hex, stmt } from './core'
import { mappedRole, ssoConfig } from './sso-config'

const schema = 'urn:ietf:params:scim:schemas:core:2.0:User'
const resource = (env: Bindings, row: any) => ({ schemas: [schema], id: row.id, externalId: row.external_id, userName: row.email, active: !!row.active, roles: [{ value: row.source_role }], meta: { resourceType: 'User', location: env.AUTH_ORIGIN + '/scim/v2/Users/' + row.id, version: String(row.revision) } })
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'content-type': 'application/scim+json', 'cache-control': 'no-store' } })

export async function scimResponse(request: Request, env: Bindings): Promise<Response | null> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith('/scim/v2/')) return null
  try {
    insist(url.origin === env.AUTH_ORIGIN, 'invalid_host', 403)
    const config = await ssoConfig(env), token = request.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1]
    insist(config && token && await sha256Hex(token) === config.scim_hash, 'invalid_credential', 401)
    const match = url.pathname.match(/^\/scim\/v2\/Users(?:\/([\w-]+))?$/)
    insist(match, 'not_found', 404)
    const id = match[1], row = id ? await one(env, 'SELECT * FROM nc_scim_users WHERE id=?', id) : null
    if (id) insist(row, 'not_found', 404)
    if (request.method === 'GET') {
      if (row) return json(resource(env, row))
      const filter = url.searchParams.get('filter'), parts = filter?.match(/^(userName|externalId) eq "([^"\\]{1,255})"$/)
      insist(!filter || parts, 'invalid_filter')
      const found = parts ? await all(env, `SELECT * FROM nc_scim_users WHERE ${parts[1] === 'userName' ? 'email' : 'external_id'}=?`, parts[1] === 'userName' ? parts[2].toLowerCase() : parts[2]) : await all(env, 'SELECT * FROM nc_scim_users ORDER BY id LIMIT 100')
      return json({ schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: found.length, startIndex: 1, itemsPerPage: found.length, Resources: found.map(row => resource(env, row)) })
    }
    insist(Number(request.headers.get('content-length') ?? 0) <= 32768, 'body_too_large', 413)
    if (request.method === 'POST' && !id) {
      const body: any = await request.json(), email = String(body.userName ?? '').trim().toLowerCase(), external = String(body.externalId ?? ''), source = body.roles?.[0]?.value
      insist(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 200 && external.length > 0 && external.length <= 255 && body.roles?.length === 1 && body.active !== false, 'invalid_user')
      const role = mappedRole(config, source), member = newId(), operator = newId(), user = newId(), at = now()
      const name = String(body.displayName ?? email).slice(0, 120)
      await commit(env, [guard(env, 'identity_exists', 'NOT EXISTS(SELECT 1 FROM nc_members WHERE email=?) AND NOT EXISTS(SELECT 1 FROM oa_operators WHERE email=?)', email, email),
        stmt(env, "INSERT INTO oa_operators(id,email,display_name,role,status,version,created_at) VALUES(?,?,?,'member','active',1,?)", operator, email, name, at),
        stmt(env, "INSERT INTO nc_members(id,email,name,role,status,created_at,updated_at) VALUES(?,?,?,?,'active',?,?)", member, email, name, role, at, at),
        stmt(env, 'INSERT INTO oa_nectar_members(member_id,operator_id) VALUES(?,?)', member, operator),
        stmt(env, 'INSERT INTO nc_scim_users VALUES(?,?,?,?,?,?,1,1)', user, external, email, member, operator, source),
        guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_sso_config WHERE revision=?)', config.revision)],
      { actor: 'system:scim', action: 'scim.create', subject: member, detail: { user, externalId: external, role } })
      return json(resource(env, await one(env, 'SELECT * FROM nc_scim_users WHERE id=?', user)), 201)
    }
    insist(row && ['PATCH', 'PUT', 'DELETE'].includes(request.method), 'method_not_allowed', 405)
    let active: boolean
    if (request.method === 'DELETE') active = false
    else {
      const body: any = await request.json()
      if (request.method === 'PATCH') {
        insist(Array.isArray(body.Operations) && body.Operations.length === 1, 'unsupported_patch')
        const op = body.Operations[0]
        insist(String(op.op).toLowerCase() === 'replace' && (op.path === 'active' || (!op.path && Object.keys(op.value ?? {}).join() === 'active')), 'unsupported_patch')
        active = op.path ? op.value : op.value.active
      } else {
        insist(body.userName?.toLowerCase() === row.email && body.externalId === row.external_id && body.roles?.length === 1 && body.roles[0].value === row.source_role, 'identity_fixed', 409)
        active = body.active
      }
      insist(typeof active === 'boolean', 'invalid_active')
    }
    await commit(env, [guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_scim_users WHERE id=? AND revision=?)', id, row.revision),
      stmt(env, 'UPDATE oa_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE operator_id=?', now(), row.operator_id),
      stmt(env, 'DELETE FROM nc_mfa_sessions WHERE member_id=?', row.member_id),
      stmt(env, "UPDATE oa_operators SET status=? WHERE id=? AND role='member'", active ? 'active' : 'inactive', row.operator_id),
      stmt(env, 'UPDATE nc_members SET status=?,updated_at=? WHERE id=?', active ? 'active' : 'ended', now(), row.member_id),
      stmt(env, 'UPDATE nc_scim_users SET active=?,revision=revision+1 WHERE id=?', active ? 1 : 0, id),
      guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_sso_config WHERE revision=?)', config.revision)],
    { actor: 'system:scim', action: active ? 'scim.activate' : 'scim.deprovision', subject: row.member_id, detail: { user: id } })
    return request.method === 'DELETE' ? new Response(null, { status: 204 }) : json(resource(env, await one(env, 'SELECT * FROM nc_scim_users WHERE id=?', id)))
  } catch (error: any) {
    return json({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: String(error.status ?? 400), detail: error.code ?? 'invalid_scim_request' }, error.status ?? 400)
  }
}
