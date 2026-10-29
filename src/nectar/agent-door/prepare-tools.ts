import type { Bindings } from '../../auth.server'
import type { JsonSchema, JsonSchemaObject, ToolContext, ToolDefinition } from '../../modules/agent-door/index.ts'
import type { Actor } from '../actor'
import { scanAssurance, recheckAssurance } from '../assurance'
import { proposeAnswerCredit } from '../answer-proposals'
import { ANSWER_TOPICS, billingAnswer } from '../billing-answers'
import { Input } from '../input'
import { previewMetric } from '../meter-definitions'
import { recordControl } from '../reconciliation'
import { submitUsage } from '../usage'
import { prepareUsageCorrection } from '../usage-dispositions'
import { previewUsageCorrection } from '../usage-replay'
import { contentClasses, nativeActor, nativeCall } from './native'
import { answerEvidence, controlEvidence, correctionEvidence, meterPreviewEvidence, recheckEvidence,
  scanEvidence, usageEvidence, type EvidenceReader } from './prepare-evidence'

const text = (maxLength: number): JsonSchema => ({ type: 'string', minLength: 1, maxLength })
const object = (properties: Record<string, JsonSchema>, required: string[]): JsonSchemaObject =>
  ({ type: 'object', properties, required, additionalProperties: false })
const resultObject = (properties: Record<string, JsonSchema>, required: string[]): JsonSchema =>
  ({ type: 'object', properties, required, additionalProperties: true })
const record: JsonSchema = { type: 'object' }
const rows: JsonSchema = { type: 'array', items: record }
const integer: JsonSchema = { type: 'integer', minimum: 0 }
const eventIds: JsonSchema = { type: 'array', maxItems: 10000, uniqueItems: true,
  items: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' } }
const period: JsonSchema = { type: 'string', pattern: '^\\d{4}-\\d{2}$', minLength: 7, maxLength: 7 }

interface PrepareTool {
  name: string
  title: string
  description: string
  scope: string
  clauses: string[]
  inputSchema: JsonSchemaObject
  outputSchema: JsonSchema
  evidence: EvidenceReader
  execute: (env: Bindings, actor: Actor, input: Input) => Promise<unknown>
  readOnly?: boolean
  revision?: boolean
  target?: boolean
}

// Every admission/approval read re-resolves native records and the sponsor's
// current native capabilities. No evidence reader saves a preview or proposal.
function tool(env: Bindings, spec: PrepareTool): ToolDefinition {
  const evidence = (args: Record<string, unknown>, ctx: ToolContext) => nativeCall(async () =>
    spec.evidence(env, await nativeActor(env, ctx), Input.of(args)))
  return {
    name: spec.name, title: spec.title, description: spec.description, scope: spec.scope,
    readOnly: spec.readOnly ?? false, clauses: spec.clauses, classes: ['standard', 'sensitive'],
    inputSchema: spec.inputSchema, outputSchema: spec.outputSchema, untrusted: true,
    classify: async (args, ctx) => {
      const current = await evidence(args, ctx)
      return contentClasses(current.content, current.count)
    },
    summary: async (args, ctx) => (await evidence(args, ctx)).summary,
    ...(spec.target ? { target: async (args: Record<string, unknown>, ctx: ToolContext) => (await evidence(args, ctx)).target ?? null } : {}),
    ...(spec.revision ? { revisionType: 'string' as const,
      revision: async (args: Record<string, unknown>, ctx: ToolContext) => (await evidence(args, ctx)).revision ?? null } : {}),
    run: async (args, ctx) => ({ result: await nativeCall(async () =>
      spec.execute(env, await nativeActor(env, ctx), Input.of(args))) }),
  }
}

const answerProperties = {
  customer: text(100), invoice: text(100), question: text(1000),
  topic: { type: 'string', enum: [...ANSWER_TOPICS] }, comparison_invoice: text(100),
  credit_amount: text(20), reason: text(500),
} satisfies Record<string, JsonSchema>
const correctionProperties = { subscription: text(100), from_period: period, through_period: period,
  void_event_ids: eventIds, add_event_ids: eventIds } satisfies Record<string, JsonSchema>
const correctionRequired = ['subscription', 'from_period', 'through_period']

export function prepareTools(env: Bindings): ToolDefinition[] {
  return [
    tool(env, {
      name: 'nectar.usage.submit', title: 'Submit usage events', scope: 'usage:write',
      description: 'Durably ingest up to 5,000 native usage events. Stable event IDs report duplicates and conflicts; only events arrays are accepted.',
      clauses: ['NEC-05', 'USE-001'], evidence: usageEvidence, execute: submitUsage,
      inputSchema: object({ events: { type: 'array', minItems: 1, maxItems: 5000,
        items: object({ event_id: text(128), customer: text(100), meter: text(100), quantity: text(24),
          occurred_at: text(100), properties: { type: 'object', maxProperties: 30,
            additionalProperties: { type: ['string', 'number', 'boolean', 'null'] } } },
        ['event_id', 'customer', 'meter', 'quantity', 'occurred_at']) } }, ['events']),
      outputSchema: resultObject({ batch: text(100), accepted: integer, duplicates: integer, rejected: integer, report: rows },
        ['batch', 'accepted', 'duplicates', 'rejected', 'report']),
    }),
    tool(env, {
      name: 'nectar.controls.record', title: 'Record daily usage control', scope: 'controls:write',
      description: 'Record or replace one sender control total for the resolved customer, meter and billing-zone day. Does not acknowledge discrepancies.',
      clauses: ['USE-007'], evidence: controlEvidence, execute: recordControl, revision: true, target: true,
      inputSchema: object({ customer: text(100), meter: text(100), day: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        expected_count: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, expected_quantity: text(24) },
      ['customer', 'meter', 'day', 'expected_count', 'expected_quantity']),
      outputSchema: resultObject({ id: text(100) }, ['id']),
    }),
    tool(env, {
      name: 'nectar.assurance.scan', title: 'Scan billing assurance', scope: 'assurance:write',
      description: 'Compare native usage controls and assurance detectors, opening or rechecking exact internal cases. New cases use an active owner or finance assignee.',
      clauses: ['AGENT-001', 'AGENT-010'], evidence: scanEvidence, execute: scanAssurance,
      inputSchema: object({ period, owner: text(100) }, ['period', 'owner']),
      outputSchema: resultObject({ coverage: { type: 'array', items: text(100) }, compared: integer,
        opened: { type: 'array', items: text(100) }, rechecked: { type: 'array', items: text(100) } },
      ['coverage', 'compared', 'opened', 'rechecked']),
    }),
    tool(env, {
      name: 'nectar.assurance.recheck', title: 'Recheck an assurance case', scope: 'assurance:write',
      description: 'Re-evaluate one native case against its source. Resolve only when the source agrees with its existing exact agreement; reopen on regression.',
      clauses: ['AGENT-001', 'AGENT-009', 'AGENT-010'], evidence: recheckEvidence, execute: recheckAssurance, revision: true, target: true,
      inputSchema: object({ case: text(100) }, ['case']),
      outputSchema: resultObject({ id: text(100), status: { type: 'string', enum: ['open', 'resolved'] }, evidence: record }, ['id', 'status', 'evidence']),
    }),
    tool(env, {
      name: 'nectar.answers.get', title: 'Get a sourced billing answer', scope: 'answers:read', readOnly: true,
      description: 'Answer a supported question about one customer and issued invoice using native immutable figures and permitted source citations. Optional credit terms only produce a draft in the answer.',
      clauses: ['AGENT-007', 'PORT-001', 'PORT-002'], evidence: answerEvidence(false), execute: billingAnswer, revision: true, target: true,
      inputSchema: object(answerProperties, ['customer', 'invoice', 'question']),
      outputSchema: resultObject({ customerId: text(100), invoiceId: text(100), question: text(1000),
        topic: { type: 'string', enum: [...ANSWER_TOPICS] }, summary: text(1000), figures: rows, citations: rows,
        details: { type: 'array', items: { type: 'string' } }, proposalDraft: record, comparison: record },
      ['customerId', 'invoiceId', 'question', 'topic', 'summary', 'figures', 'citations', 'details']),
    }),
    tool(env, {
      name: 'nectar.answers.propose', title: 'Prepare a cited answer credit', scope: 'answers:write',
      description: 'Turn an explicit requested invoice credit into a pending native proposal with source citations. Does not post a credit, send a message or approve a financial change.',
      clauses: ['AGENT-007', 'NEC-14'], evidence: answerEvidence(true), execute: proposeAnswerCredit, revision: true, target: true,
      inputSchema: object(answerProperties, ['customer', 'invoice', 'question', 'credit_amount', 'reason']),
      outputSchema: resultObject({ id: text(100), kind: text(40), impact: record }, ['id', 'kind', 'impact']),
    }),
    tool(env, {
      name: 'nectar.corrections.preview', title: 'Preview historical usage correction', scope: 'corrections:read', readOnly: true,
      description: 'Replay up to 36 issued native usage periods and show exact before/after billing deltas without posting or preparing a correction.',
      clauses: ['USE-004', 'AGENT-002'], evidence: correctionEvidence(false), execute: previewUsageCorrection, revision: true, target: true,
      inputSchema: object(correctionProperties, correctionRequired),
      outputSchema: resultObject({ status: text(40), scope: text(100), subscription: text(100), fromPeriod: period,
        throughPeriod: period, voidEventIds: eventIds, addEventIds: eventIds, periods: rows, delta: record, fingerprint: text(100), warning: { type: 'string' } },
      ['status', 'scope', 'subscription', 'fromPeriod', 'throughPeriod', 'voidEventIds', 'addEventIds', 'periods', 'delta', 'fingerprint', 'warning']),
    }),
    tool(env, {
      name: 'nectar.corrections.prepare', title: 'Prepare a usage correction', scope: 'corrections:write',
      description: 'Freeze a complete issued usage correction chain, exact financial plan and customer explanation under the saved native correction policy. Does not apply the correction or send its message.',
      clauses: ['USE-004', 'NEC-14', 'AGENT-002'], evidence: correctionEvidence(true), execute: prepareUsageCorrection, revision: true, target: true,
      inputSchema: object({ ...correctionProperties, reason: text(500), explanation: text(8000) }, [...correctionRequired, 'reason', 'explanation']),
      outputSchema: resultObject({ id: text(100), status: text(40), basis: text(100), plan: record }, ['id', 'status', 'basis', 'plan']),
    }),
    tool(env, {
      name: 'nectar.meters.preview', title: 'Save a historical meter preview', scope: 'meters:write',
      description: 'Evaluate an existing native metric request on one customer’s past calendar month and save the exact preview. Does not prepare or activate a meter.',
      clauses: ['USE-002'], evidence: meterPreviewEvidence, execute: previewMetric, revision: true, target: true,
      inputSchema: object({ request: text(100), customer: text(100), period }, ['request', 'customer', 'period']),
      outputSchema: resultObject({ preview: text(100), period: record, fingerprint: text(100), results: rows }, ['preview', 'period', 'fingerprint', 'results']),
    }),
  ]
}
