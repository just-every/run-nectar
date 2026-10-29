import { authConfig, operatorAuth, type Bindings } from '../../auth.server'
import type { PeopleAdapter, Person } from '../../modules/agent-door/types'
import { SettingsError, type Statement, type TeamAdapter } from '../../modules/business-settings/types'
import { isActiveOperator, type Operator } from '../../modules/operator-auth/index.mjs'
import { currentActor, type Role } from '../actor'
import { mfaHold } from '../mfa'

interface BoundMember {
  id: string; name: string; role: Role; status: string; operator_id: string
  operatorEmail: string; operatorName: string; operatorRole: string; operatorStatus: string
}
interface NativePerson extends Person { policyRole: 'owner' | 'editor' | null }
const boundColumns = `m.id,m.name,m.role,m.status,m.operator_id,o.email AS operatorEmail,
  o.display_name AS operatorName,o.role AS operatorRole,o.status AS operatorStatus`
const setupOwner = `SELECT o.id FROM oa_operators o LEFT JOIN oa_bootstrap b ON b.claim_id=o.id
  WHERE o.role='owner' AND o.status='active' ORDER BY b.claim_id IS NULL,o.created_at,o.id LIMIT 1`

/** Business subjects resolve only through saved operator IDs, never a token's email. */
export function nectarPeople(env: Bindings): PeopleAdapter {
  const db = env.DB
  async function read(id: string): Promise<NativePerson | null> {
    const row = await db.prepare(`SELECT ${boundColumns} FROM nc_members m
      JOIN oa_operators o ON o.id=m.operator_id WHERE m.id=?`).bind(id).first<BoundMember>()
    if (!row) return null
    const operator = { id: row.operator_id, email: row.operatorEmail, displayName: row.operatorName,
      role: row.operatorRole, status: row.operatorStatus } as Operator
    const signed = await db.prepare(`SELECT business_role FROM bs_team WHERE operator_id=?
      AND state IN ('active','invited') AND business_id IS NOT NULL`).bind(row.operator_id).first<{ business_role: string }>()
    return { id: row.id, name: row.name, email: row.operatorEmail,
      role: row.operatorRole === 'owner' ? 'owner' : row.role === 'owner' ? 'finance' : row.role,
      policyRole: row.operatorRole === 'owner' ? 'owner' : signed?.business_role === 'admin' ? 'editor' : null,
      active: row.status === 'active' && isActiveOperator(operator, authConfig(env).allowList) }
  }
  const owner = () => db.prepare(`SELECT m.id,m.operator_id FROM nc_members m
    WHERE m.operator_id=(${setupOwner})`).first<{ id: string; operator_id: string }>()
  const settings = () => db.prepare('SELECT owner_id FROM bs_settings WHERE singleton=1 AND stopped=0')
    .first<{ owner_id: string | null }>()
  async function active(id: string) {
    const person = await read(id)
    return person?.active ? person : null
  }
  async function membership(person: Person): Promise<{ id: string; role: 'owner' | 'editor' | null } | null> {
    if (!await active(person.id)) return null
    const saved = await settings()
    if (!saved) return null
    if (saved.owner_id && (await owner())?.id === person.id) return { id: saved.owner_id, role: 'owner' }
    const row = await db.prepare(`SELECT t.business_id,t.business_role FROM bs_team t
      JOIN nc_members m ON m.operator_id=t.operator_id WHERE m.id=?
      AND t.state IN ('active','invited') AND t.business_id IS NOT NULL`).bind(person.id)
      .first<{ business_id: string; business_role: string | null }>()
    return row ? { id: row.business_id, role: row.business_role === 'admin' ? 'editor' : null } : null
  }
  return {
    person: read,
    businessRole: person => (person as NativePerson).policyRole ?? null,
    async sponsor({ sub }) {
      const saved = await settings()
      if (!saved) return null
      if (saved.owner_id === sub) {
        const native = await owner()
        return native ? active(native.id) : null
      }
      const row = await db.prepare(`SELECT m.id FROM bs_team t JOIN nc_members m ON m.operator_id=t.operator_id
        WHERE t.business_id=? AND t.state IN ('active','invited')`).bind(sub).first<{ id: string }>()
      return row ? active(row.id) : null
    },
    businessMember: membership,
    async session(request) {
      const actor = await currentActor(env, request)
      if (!actor || actor.kind !== 'member' || !actor.sessionId || await mfaHold(env, actor)) return null
      return active(actor.id)
    },
  }
}

interface NativeMembership { id: string; operator_id: string | null; email: string; role: Role; status: string; name: string; updated_at: number }

/** Keep native auth's signed roster plan and invitations, adding Nectar's own membership in its batch. */
export function nectarTeam(env: Bindings): TeamAdapter {
  const native = () => operatorAuth(env).businessTeam!
  return {
    ownerEmail: () => native().ownerEmail(),
    async prepare(input) {
      const plan = await native().prepare({ ...input, roles: { admin: 'admin', member: 'member' } })
      const statements: Statement[] = [...plan.statements]
      const desired = new Map(input.members.map(member => [member.email.toLowerCase(), member]))
      const managed = new Set(input.managed.filter(row => row.state !== 'conflict').map(row => row.operatorId))
      const { guard } = input
      const at = Date.now()
      for (const row of plan.rows) {
        if (row.state === 'conflict' || !row.operatorId) continue
        const operator = await env.DB.prepare('SELECT email FROM oa_operators WHERE id=?')
          .bind(row.operatorId).first<{ email: string }>()
        const email = operator?.email ?? row.email
        const matches = (await env.DB.prepare('SELECT id,operator_id,email,role,status,name,updated_at FROM nc_members WHERE operator_id=? OR email=?')
          .bind(row.operatorId, email).all<NativeMembership>()).results
        const member = matches.find(value => value.operator_id === row.operatorId)
        // Neither a matching address nor a new Business identity may adopt an unrelated native membership.
        if (matches.some(value => value !== member) || member && (!managed.has(row.operatorId) || member.role === 'owner')) {
          throw new SettingsError('business_member_binding_mismatch')
        }
        const requested = desired.get(row.email.toLowerCase())
        const previous = input.managed.find(value => value.operatorId === row.operatorId)
        const businessRole = requested?.role ?? previous?.businessRole
        if (businessRole !== 'admin' && businessRole !== 'member') throw new SettingsError('business_member_binding_mismatch')
        const nativeRole = businessRole === 'admin' ? 'finance' : 'accountant'
        const status = row.state === 'inactive' ? 'ended' : 'active'
        const id = member?.id ?? crypto.randomUUID()
        // Assertions run after the OA lifecycle statements, under the same signed revision fence.
        statements.push(env.DB.prepare(`INSERT INTO bs_assert(value) SELECT CASE WHEN
          EXISTS(SELECT 1 FROM oa_operators WHERE id=? AND role=? AND status=?)
          AND NOT EXISTS(SELECT 1 FROM nc_members m JOIN oa_operators o ON o.id=?
            WHERE m.email=o.email AND (m.operator_id IS NULL OR m.operator_id<>?))
          AND ${member ? 'EXISTS(SELECT 1 FROM nc_members WHERE id=? AND operator_id=? AND email=? AND role=? AND status=? AND name=? AND updated_at=?)'
            : 'NOT EXISTS(SELECT 1 FROM nc_members WHERE operator_id=?)'}
          THEN 1 ELSE NULL END WHERE ${guard.sql}`)
          .bind(row.operatorId, businessRole, row.state, row.operatorId, row.operatorId,
            ...(member ? [member.id, row.operatorId, member.email, member.role, member.status, member.name, member.updated_at] : [row.operatorId]), ...guard.args))
        if (member) {
          statements.push(env.DB.prepare(`UPDATE nc_members SET email=(SELECT email FROM oa_operators WHERE id=?),
            name=(SELECT display_name FROM oa_operators WHERE id=?),role=?,status=?,updated_at=?
            WHERE id=? AND operator_id=? AND ${guard.sql} AND
            (email<>(SELECT email FROM oa_operators WHERE id=?) OR name<>(SELECT display_name FROM oa_operators WHERE id=?) OR role<>? OR status<>?)`)
            .bind(row.operatorId, row.operatorId, nativeRole, status, at, id, row.operatorId, ...guard.args,
              row.operatorId, row.operatorId, nativeRole, status))
        } else {
          statements.push(env.DB.prepare(`INSERT INTO nc_members(id,operator_id,email,name,role,status,created_at,updated_at)
            SELECT ?,o.id,o.email,o.display_name,?,?,?,? FROM oa_operators o WHERE o.id=? AND ${guard.sql}`)
            .bind(id, nativeRole, status, at, at, row.operatorId, ...guard.args))
        }
        statements.push(env.DB.prepare(`INSERT INTO nc_audit(at,actor,action,subject,detail)
          SELECT ?,?,?,?,? WHERE changes()>0 AND ${guard.sql}`)
          .bind(at, `Business ${input.ownerEmail}`, status === 'ended' ? 'access.end' : 'access.give', id,
            JSON.stringify({ via: 'business', operator: row.operatorId, role: nativeRole, status }), ...guard.args))
      }
      return { statements, rows: plan.rows, afterCommit: () => plan.afterCommit() }
    },
  }
}
