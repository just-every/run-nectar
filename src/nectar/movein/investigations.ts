// Read-only comparisons of uploaded fixed and seat invoice facts with current engine inputs.
// Captured prose and original objects never enter agent evidence.
import type { Bindings } from '../../auth.server'
import { all, fingerprint, parseJson, type Row } from '../core'
import { requireBusiness } from '../business'
import { isDate, periodContaining } from '../dates'
import { decimalText, micros } from '../decimal'
import { rated } from '../inputs'
import { historyReference } from './history-reports'

export const MOVE_KIND = 'move_comparison'

export async function moveInvestigationEvidence(env: Bindings): Promise<Row[]> {
  const business = await requireBusiness(env)
  const documents = await all(env, `SELECT i.*,s.anchor_day,s.billing_mode FROM nc_incumbent_invoices i
    JOIN nc_subscriptions s ON s.id=i.subscription_id JOIN nc_customers c ON c.id=i.customer_id
    WHERE i.provider='stripe' AND i.document_kind='invoice' AND i.status IN ('open','paid','uncollectible')
      AND s.billing_mode='shadow' AND c.erased_at IS NULL ORDER BY i.id`)
  const refs = new Map((await all(env,'SELECT id,provider_ref FROM nc_prices')).map(row=>[row.id,row.provider_ref]))
  const results: Row[] = []
  for (const document of documents) {
    if (!isDate(document.period_start)) continue
    const capturedLines = parseJson<Row[]>(document.lines_json,[])
    const lines = capturedLines.filter(line=>line.kind!=='discount')
    // Ambiguous, metered and incomplete captures remain outside this supported comparison.
    if (!lines.length || new Set(lines.map(line=>line.price_ref)).size!==lines.length || lines.some(line=>
      !historyReference(line.source_id) || !historyReference(line.price_ref) || !isDate(line.period_start) || !isDate(line.period_end) ||
      !Number.isSafeInteger(line.quantity) || line.quantity<1 || !line.price_source ||
      !/^\d{1,12}(\.\d{1,4})?$/.test(String(line.price_source.unit_amount_decimal??line.price_source.unit_amount??'')) ||
      line.price_source.currency!=='usd' || line.price_source.recurring?.usage_type==='metered' || line.proration ||
      line.interval!=='month' || line.interval_count!==1)) continue
    const period = periodContaining(document.anchor_day,document.period_start)
    const engine = await rated(env,business,document.subscription_id,period)
    if (Object.values(engine.input.prices).some(price=>!['flat','seat'].includes(price.kind)||price.pricing)) continue
    const provenance = (await all(env,"SELECT job_id,record_json FROM ik_provenance WHERE target_kind='invoice' AND target_id=? AND reversed=0",document.id))[0]
    if (!provenance) continue
    const record = parseJson<Row>(provenance.record_json,{})
    const differences: Row[] = [], comparisons: Row[] = []
    for (const line of lines) {
      const matches = engine.rating.lines.filter(native=>native.priceId && refs.get(native.priceId)===line.price_ref && ['flat','seat'].includes(native.kind))
      const source = { line:line.source_id,price:line.price_ref,quantity:line.quantity,
        unitAmount:decimalText(micros(String(line.price_source.unit_amount_decimal??line.price_source.unit_amount))/100n),
        from:line.period_start,to:line.period_end,amountCents:line.amount_cents }
      const native = matches.length===1 ? matches[0] : null
      const actual = native ? { item:native.evidence.item,price:native.priceId,quantity:Number(native.quantity),unitAmount:decimalText(micros(native.unitAmount)),
        from:native.periodStart,to:native.periodEnd,amountCents:native.amountCents } : null
      const fields = actual ? ['quantity','unitAmount','from','to','amountCents'].filter(key=>source[key as keyof typeof source]!==actual[key as keyof typeof actual]) : ['missing_line']
      for (const field of fields) differences.push({line:line.source_id,field,captured:field==='missing_line'?source:source[field as keyof typeof source],engine:actual?.[field as keyof typeof actual]??null})
      comparisons.push({captured:source,engine:actual})
    }
    const unmatched = engine.rating.lines.filter(line=>line.priceId && !lines.some(source=>source.price_ref===refs.get(line.priceId!))).map(line=>({price:line.priceId,amountCents:line.amountCents}))
    if (unmatched.length) differences.push({field:'additional_lines',captured:[],engine:unmatched})
    const capturedSubtotalCents=capturedLines.reduce((sum,line)=>sum+line.amount_cents,0)
    if(capturedSubtotalCents!==engine.rating.subtotalCents && !differences.some(difference=>difference.field==='amountCents'))
      differences.push({field:'subtotalCents',captured:capturedSubtotalCents,engine:engine.rating.subtotalCents})
    const proof = {kind:MOVE_KIND,source:`move:${document.id}`,customer:document.customer_id,subscription:document.subscription_id,
      capturedInvoice:document.id,invoiceReference:historyReference(document.provider_ref)?document.provider_ref:null,
      period,capturedSubtotalCents,engineSubtotalCents:engine.rating.subtotalCents,citation:{job:provenance.job_id,artifactHash:record.artifactHash,sourceHash:record.sourceHash,row:record.location?.row},
      captureBasis:await fingerprint([document.source_json,document.lines_json]),engineBasis:engine.fingerprint,
      comparisons,differences,mismatch:differences.length>0}
    results.push({...proof,basis:await fingerprint(proof)})
  }
  return results
}
