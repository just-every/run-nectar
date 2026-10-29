import type { Bindings } from '../../auth.server'
import type { ToolDefinition } from '../../modules/agent-door/index.ts'
import { audit } from '../views'
import { nativeActor, nativeCall } from './native'

/** Audit-safe native witness: private detail stays on its existing person door. */
export function readTools(env: Bindings): ToolDefinition[] {
  return [{
    name: 'nectar.audit.list', title: 'Read native activity references', scope: 'audit:read', readOnly: true,
    description: 'Read native audit sequence, action and opaque subject references. Private detail is available only through its native person door.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object', required: ['rows'], additionalProperties: false, properties: {
      rows: { type: 'array', items: { type: 'object', required: ['seq', 'at', 'action', 'subject'], additionalProperties: false,
        properties: { seq: { type: 'integer' }, at: { type: 'integer' }, action: { type: 'string' }, subject: { type: 'string' } } } },
    } },
    classes: ['standard'], clauses: ['GOV-004'],
    classify: async (_args, ctx) => {
      await nativeCall(async () => audit(env, await nativeActor(env, ctx)))
      return [{ class: 'standard', facts: { measure: 1 } }]
    },
    run: async (_args, ctx) => ({ result: { rows: (await nativeCall(async () => audit(env, await nativeActor(env, ctx))))
      .map(({ seq, at, action, subject }) => ({ seq, at, action, subject })) } }),
  }]
}
