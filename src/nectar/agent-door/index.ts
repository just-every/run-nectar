import { createAgentDoor, type Capability, type Trust } from '../../modules/agent-door/index.ts'
import { createBusinessSettings } from '../../modules/business-settings/index.ts'
import type { Bindings } from '../../auth.server'
import { one, sha256Hex } from '../core'
import { nectarPeople, nectarTeam } from './people'
import { prepareTools } from './prepare-tools'
import { readTools } from './read-tools'

export const capabilities: Capability[] = ['tools', 'policy', 'pause', 'audit', 'idempotency']
export const specialist = 'billing-controller'
const prepareScopes = ['assurance:write', 'answers:read', 'answers:write', 'corrections:read', 'corrections:write', 'meters:write']
const scopes = (native: string) => [...new Set(native.split(' ').flatMap(scope =>
  scope === 'prepare' ? prepareScopes : scope === 'usage' ? ['usage:write', 'controls:write'] : []))]

function trust(env: Bindings): Trust | null {
  const { RER_OWNER_CLAIM_ISSUER: issuer, RER_OWNER_CLAIM_INSTALLATION_ID: installationId,
    RER_OWNER_CLAIM_PUBLIC_KEYS: publicKeys } = env
  if (!issuer && !installationId && !publicKeys) return null
  if (!issuer || !installationId || !publicKeys) throw new Error('Incomplete agent door trust')
  return { issuer, installationId, appOrigin: env.AUTH_ORIGIN, publicKeys: JSON.parse(publicKeys) }
}

export const notTools = [
  { reason: 'import-door' as const, clauses: ['NEC-16', 'MOVE-001', 'MOVE-002', 'MOVE-003', 'MOVE-004', 'MOVE-005', 'MOVE-006', 'MOVE-007', 'MOVE-008', 'MOVE-010'] },
  { reason: 'connector' as const, clauses: ['USE-003', 'RPT-004', 'CRM-001', 'CRM-002', 'INT-001', 'INT-002', 'AR-005'] },
  { reason: 'installation' as const, clauses: ['DEV-003', 'DEV-004', 'OPS-001'] },
  { reason: 'screen' as const, clauses: ['MOB-001', 'MOB-003', 'GOV-002', 'GOV-007'] },
  { reason: 'device' as const, clauses: ['MOB-002'] },
]

export function nectarDoor(env: Bindings) {
  const people = nectarPeople(env)
  return createAgentDoor({ seed: 'nectar', name: 'Nectar', specialist, db: env.DB, origin: env.AUTH_ORIGIN,
    trust: trust(env), capabilities, people, tools: [...readTools(env), ...prepareTools(env)], resources: [], notTools,
    async localCredentials(request) {
      const key = request.headers.get('authorization')?.match(/^Bearer (nectar_[A-Za-z0-9_-]{20,100})$/)?.[1]
      if (!key) return null
      const row = await one(env, 'SELECT id,name,scopes,sponsor_member_id FROM nc_agent_keys WHERE key_hash=? AND revoked_at IS NULL', await sha256Hex(key))
      if (!row?.sponsor_member_id || !(await people.person(row.sponsor_member_id))?.active) return null
      return { sponsor: { id: row.sponsor_member_id }, agent: { id: row.id, name: row.name, specialist }, scopes: scopes(row.scopes), clientId: row.id }
    },
    async currentScopes(principal) {
      if (principal.consent || !principal.clientId) return principal.scopes
      const row = await one(env, 'SELECT scopes,sponsor_member_id FROM nc_agent_keys WHERE id=? AND revoked_at IS NULL', principal.clientId)
      return row?.sponsor_member_id === principal.person.id ? scopes(row.scopes) : []
    },
  })
}

/** An installation without its canonical origin cannot advertise or admit agents. */
export async function nectarAgentResponse(request: Request, env: Bindings): Promise<Response | null> {
  if (!env.AUTH_ORIGIN) {
    const path = new URL(request.url).pathname
    if (path === '/mcp' || path === '/api/rer/agent-policy' || path === '/agents' || path.startsWith('/agents/')
      || path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
      return Response.json({ code: 'installation_not_configured' }, { status: 503, headers: { 'cache-control': 'no-store' } })
    }
    return null
  }
  return nectarDoor(env).handle(request)
}

export function nectarBusinessSettings(env: Bindings) {
  return createBusinessSettings({ db: env.DB, trust: env.RER_BUSINESS_TRUST,
    business: { settings: 1, values: ['display_name'], team: { roles: { admin: 'finance', member: 'accountant' } } }, team: nectarTeam(env) })
}
