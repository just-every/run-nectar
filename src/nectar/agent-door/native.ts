import type { Bindings } from '../../auth.server'
import { ToolRefusal, type ClassAndFacts, type ToolContext } from '../../modules/agent-door/index.ts'
import { memberCapabilities, RECORD_FAMILIES, type Actor, type Capability, type Role } from '../actor'
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
  if (requested.has('read')) for (const family of RECORD_FAMILIES) requested.add(`read.${family}`)
  return { id: ctx.consent ? ctx.agent.id : ctx.clientId ?? ctx.agent.id, kind: 'agent', name: ctx.agent.name, email: '', role: null,
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
  const records = new Map<string, Set<string>>()
  const opaque = /^(?:id|event_?id|external_id|customer_?id|meter_?id|subscription_?id|invoice_?id|source_id|record_id|source_fingerprint|basis|basis_hash|fingerprint)$/i
  function visit(item: unknown, path = 'record', record = 'record') {
    if (!item || typeof item !== 'object') return
    if (Array.isArray(item)) { item.forEach((entry, i) => visit(entry, `${path}/${i}`, `${path}/${i}`)); return }
    const row = item as Record<string, unknown>
    const identity = row.id ?? row.event_id ?? row.eventId
    const current = typeof identity === 'string' ? identity : record
    for (const [key, content] of Object.entries(row)) {
      if (content && typeof content === 'object') { visit(content, `${path}/${key}`, current); continue }
      if (!['string', 'number', 'boolean'].includes(typeof content) || opaque.test(key) || content === '') continue
      const text = String(content)
      if (/^(?:[x*• -]+|.*(?:last.?four|last.?4|ending in)\D*\d{4})$/i.test(text)) continue
      const kind = /\b\d{3}-\d{2}-\d{4}\b|\b\d{2}-\d{7}\b/.test(text) || /^(?:ssn|ein|tax_?id)$/i.test(key) ? 'ID'
        : /(?:bank|routing|iban|account_number)/i.test(key) || /\b(?:bank|routing|account)[ _-]?(?:number|no)[\s:=_-]*\d{6,}\b/i.test(text) ? 'bank'
        : /(?:card_number|pan)/i.test(key) || /\b(?:card|pan)[ _-]?(?:number|no)?[\s:=_-]*\d{13,19}\b/i.test(text) ? 'card'
        : /(?:diagnosis|medical_record|patient|health)/i.test(key) || /\b(?:diagnos(?:is|ed)|patient|HIV|medical history)\b/i.test(text) ? 'health'
        : /(?:payroll|salary|wage)/i.test(key) ? 'payroll' : null
      if (kind) { const found = records.get(kind) ?? new Set<string>(); found.add(current); records.set(kind, found) }
    }
  }
  visit(value)
  const kinds = [...records.keys()].sort()
  const protectedRecords = new Set([...records.values()].flatMap(found => [...found]))
  return [{ class: 'standard', facts: { measure } }, ...(kinds.length ? [{ class: 'sensitive' as const,
    facts: { measure: protectedRecords.size, kind: kinds.join(',') } }] : [])]
}
