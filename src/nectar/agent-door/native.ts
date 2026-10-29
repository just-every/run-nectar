import type { Bindings } from '../../auth.server'
import { ToolRefusal, type ClassAndFacts, type ToolContext } from '../../modules/agent-door/index.ts'
import { memberCapabilities, type Actor, type Capability, type Role } from '../actor'
import { NectarError, one } from '../core'

const grants: Record<string, Capability[]> = {
  'usage:write': ['usage'], 'usage:read': ['read'], 'controls:write': ['usage'],
  'assurance:read': ['read'], 'assurance:write': ['read', 'propose'],
  'answers:read': ['read'], 'answers:write': ['read', 'propose'],
  'corrections:read': ['read'], 'corrections:write': ['read', 'propose'],
  'meters:write': ['read'], 'billing:read': ['read'], 'audit:read': ['read', 'export'],
}

/** Preserve native agent identity. Company approval never makes it a member. */
export async function nativeActor(env: Bindings, ctx: ToolContext): Promise<Actor> {
  const member = await one(env, `SELECT m.*,r.capabilities AS custom FROM nc_members m
    LEFT JOIN nc_roles r ON r.id=m.custom_role_id JOIN oa_operators o ON o.id=m.operator_id
    WHERE m.id=? AND m.status='active' AND o.status='active'`, ctx.person.id)
  if (!member) throw new ToolRefusal('unauthenticated')
  const held = memberCapabilities(member.role as Role, member.custom)
  const requested = new Set(ctx.scopes.flatMap(scope => grants[scope] ?? []))
  return { id: ctx.clientId ?? ctx.agent.id, kind: 'agent', name: ctx.agent.name, email: '', role: null,
    sessionId: null, capabilities: new Set([...held].filter(cap => requested.has(cap))), attribution: ctx.actor.label }
}

export async function nativeCall<T>(run: () => Promise<T>): Promise<T> {
  try { return await run() }
  catch (error) {
    if (error instanceof NectarError) throw new ToolRefusal(error.status === 404 || error.status === 403 ? 'resource_unavailable' : error.code)
    throw error
  }
}

/** Classify retained content, never instructions supplied alongside the call. */
export function contentClasses(value: unknown, measure = 1): ClassAndFacts[] {
  const text = JSON.stringify(value) ?? ''
  const kind = /\b\d{3}-\d{2}-\d{4}\b|\b\d{2}-\d{7}\b/.test(text) ? 'ID'
    : /\b(?:bank|routing|account)[ _-]?(?:number|no)["\s:=_-]*\d{6,}\b/i.test(text) ? 'bank'
    : /\b(?:card|pan)[ _-]?(?:number|no)?["\s:=_-]*\d{13,19}\b/i.test(text) ? 'card' : null
  return [{ class: 'standard', facts: { measure } }, ...(kind ? [{ class: 'sensitive' as const, facts: { measure, kind } }] : [])]
}
