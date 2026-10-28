import type { EntitlementDecision, NectarClient, UsageEvent, UsageSubmissionResult } from '../../../sdks/typescript/src/index.js'

export interface MeterThenGateInput {
  event: UsageEvent
  feature: string
  date?: string
  idempotencyKey: string
}
export interface GateResult {
  allowed: boolean
  usage: UsageSubmissionResult
  decision: EntitlementDecision
}

/** Record an observed event, then evaluate access using the recorded facts. */
export async function meterThenGate(
  client: NectarClient,
  input: MeterThenGateInput,
  readClient: NectarClient = client,
): Promise<GateResult> {
  const usage = await client.usage.submit({ events: [input.event] }, { idempotencyKey: input.idempotencyKey })
  // A valid HTTP response can still contain a rejected event. Do not treat it as metered.
  if (usage.rejected !== 0 || usage.accepted + usage.duplicates !== 1) {
    throw new Error('The usage event was not accepted or recognized as an unchanged duplicate')
  }
  const decision = await readClient.entitlements.check({
    customer: input.event.customer, feature: input.feature, date: input.date,
  })
  if (decision.allowed) return { allowed: true, usage, decision }
  return { allowed: false, usage, decision }
}
