// Captured customer fields are compared without copying contact values into cases.
import type { Bindings } from '../../auth.server'
import { all, fingerprint, parseJson, type Row } from '../core'
import { loadPlans } from '../../modules/import-kit/src/d1/plans'
import { historyReference } from './history-reports'

export async function moveCustomerEvidence(env: Bindings): Promise<Row[]> {
  const rows = await all(env, `SELECT c.*,p.job_id,p.record_json,p.source_identity FROM nc_customers c
    JOIN ik_provenance p ON p.target_kind='customer' AND p.target_id=c.id AND p.reversed=0
    WHERE c.origin='import' AND c.erased_at IS NULL AND EXISTS(
      SELECT 1 FROM nc_subscriptions s WHERE s.customer_id=c.id AND s.billing_mode='shadow') ORDER BY c.id`)
  const jobs = await all(env, "SELECT * FROM ik_jobs WHERE namespace='stripe' AND destination='billing' AND id IN (SELECT p.job_id FROM ik_provenance p JOIN nc_customers c ON c.id=p.target_id WHERE p.target_kind='customer' AND p.reversed=0 AND c.origin='import' AND c.erased_at IS NULL AND EXISTS(SELECT 1 FROM nc_subscriptions s WHERE s.customer_id=c.id AND s.billing_mode='shadow'))")
  const plans = await loadPlans(jobs,env.DB as never)
  const results: Row[] = []
  for (const customer of rows) {
    const record = parseJson<Row>(customer.record_json, {})
    const entry = plans.get(customer.job_id)?.entries.find(entry=>entry.identity===customer.source_identity)
    const value = entry?.effects.find(effect=>effect.targetKind==='customer'&&effect.targetId===customer.id)?.value as Row | undefined
    if (!value || !historyReference(value.providerRef)) continue
    const captured = { name:value.name,billingContact:value.billingEmail,address:value.address,taxExempt:!!value.taxExempt }
    const actual = { name: customer.name, billingContact: customer.billing_email, address: customer.address, taxExempt: !!customer.tax_exempt }
    const differences = Object.keys(captured).filter(key => captured[key as keyof typeof captured] !== actual[key as keyof typeof actual]).map(field => ({
      field, captured: field === 'taxExempt' ? captured.taxExempt : 'Captured value', engine: field === 'taxExempt' ? actual.taxExempt : 'Changed value',
    }))
    const proof = { kind:'move_comparison', category:'customer', source:`move-customer:${customer.id}`,customer:customer.id,
      invoiceReference:value.providerRef, comparisons:[], differences,mismatch:differences.length>0,
      citation:{job:customer.job_id,artifactHash:record.artifactHash,sourceHash:record.sourceHash,row:record.location?.row},
      captureBasis:await fingerprint(captured),engineBasis:await fingerprint(actual) }
    results.push({...proof,basis:await fingerprint(proof)})
    // Only an explicit captured default and one binding-valid complete inventory
    // establish this limited comparison. Missing inventory never invents agreement.
    const source = entry?.source.payload as Row | undefined
    const rawMethod = source?.invoice_settings?.default_payment_method
    const methodRef = typeof rawMethod==='string' ? rawMethod : rawMethod?.id
    if (!historyReference(methodRef)) continue
    const observations = await all(env, `SELECT s.* FROM nc_customer_payment_method_snapshots s
      JOIN nc_stripe_customer_bindings b ON b.id=s.binding_id AND b.revision=s.binding_revision
        AND b.account_ref=s.account_ref AND b.stripe_customer_ref=s.stripe_customer_ref AND b.customer_id=s.customer_id
      WHERE s.customer_id=? AND s.stripe_customer_ref=? AND NOT EXISTS(
        SELECT 1 FROM nc_erased_records e WHERE e.record_id IN (s.id,b.id)) ORDER BY s.id`,customer.id,value.providerRef)
    if (observations.length!==1) continue
    const observation=observations[0]
    const methods=await all(env,'SELECT payment_method_ref FROM nc_customer_payment_methods WHERE snapshot_id=? ORDER BY payment_method_ref',observation.id)
    const present=methods.some(method=>method.payment_method_ref===methodRef)
    const methodProof={kind:'move_comparison',category:'payment-method',source:`move-method:${customer.id}`,customer:customer.id,
      invoiceReference:methodRef,comparisons:[],differences:present?[]:[{field:'savedMethod',captured:methodRef,engine:null}],mismatch:!present,
      coverage:'captured-default-membership-only',citation:proof.citation,captureBasis:record.sourceHash,
      engineBasis:await fingerprint({account:observation.account_ref,binding:observation.binding_revision,fetchedAt:observation.fetched_at,methods})}
    results.push({...methodProof,basis:await fingerprint(methodProof)})
  }
  return results
}
