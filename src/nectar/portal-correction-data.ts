// Only approved, frozen customer explanations and their exact engine effects.
// No proposal payload, preparer, recipient, provider reference or internal link.
import type { Bindings } from '../auth.server'
import { all, insist, parseJson, type Row } from './core'
import type { CustomerSession } from './portal-session'

const engineFigures = (value: Row) => ({ fingerprint: value.fingerprint,
  subtotalCents: value.subtotalCents, taxCents: value.taxCents, totalCents: value.totalCents,
  lines: (value.lines as Row[]).map(line => ({ description: line.description, amountCents: line.amountCents })) })

export async function portalCorrectionsData(env: Bindings, session: CustomerSession, proposalId?: string) {
  const filter = proposalId ? ' AND p.id=?' : ''
  const args = [session.customer, ...(proposalId ? [proposalId] : [])]
  const corrections: Row[] = []
  for (const row of await all(env, `SELECT p.id,p.kind,p.impact_json,p.payload_json,m.subject,m.body,m.explanation,m.status,
    m.credit_id,i.id AS invoice_id,i.number FROM nc_credit_correction_mail m JOIN nc_proposals p ON p.id=m.proposal_id
    JOIN nc_invoices i ON i.id=(json_extract(p.payload_json,'$.invoice')) AND i.customer_id=m.customer_id
    JOIN nc_customers c ON c.id=m.customer_id WHERE m.customer_id=? AND c.erased_at IS NULL
    AND p.status='approved' AND i.status='issued'${filter} ORDER BY m.created_at,p.id`, ...args)) {
    const impact = parseJson<Row>(row.impact_json, {})
    corrections.push({ id: row.id, kind: 'invoice_credit', invoiceId: row.invoice_id, invoiceNumber: row.number,
      creditId: row.credit_id, original: { subtotalCents: impact.invoice.subtotalCents, taxCents: impact.invoice.taxCents,
        totalCents: impact.invoice.totalCents }, credit: { amountCents: impact.credit.amountCents,
        balanceBeforeCents: impact.credit.balanceBeforeCents, balanceAfterCents: impact.credit.balanceAfterCents },
      message: { subject: row.subject, body: row.body, explanation: row.explanation, status: row.status },
      citations: [{ source: `/portal/corrections/${encodeURIComponent(row.id)}`, recordPath: '/corrections/0/original',
        invoiceSource: `/portal/invoices/${encodeURIComponent(row.invoice_id)}`, label: row.number }], periods: [] })
  }
  const subscriptions = new Set((await all(env, 'SELECT id FROM nc_subscriptions WHERE customer_id=?', session.customer)).map(row => row.id))
  for (const row of await all(env, `SELECT p.id,p.kind,p.impact_json,p.payload_json,m.subject,m.body,m.status
    FROM nc_draft_correction_mail m JOIN nc_proposals p ON p.id=m.proposal_id JOIN nc_customers c ON c.id=m.customer_id
    WHERE m.customer_id=? AND c.erased_at IS NULL AND p.status='approved'${filter} ORDER BY m.created_at,p.id`, ...args)) {
    const payload = parseJson<Row>(row.payload_json, {}), impact = parseJson<any>(row.impact_json, {})
    const affected: Row[] = row.kind === 'amendment'
      ? impact.map((entry: Row) => ({ ...entry, subscription: payload.subscription })) : impact.invoices
    const periods = affected.filter(entry => subscriptions.has(entry.subscription)).map(entry => ({
      subscription: entry.subscription, period: { start: entry.period.start, end: entry.period.end },
      before: engineFigures(entry.before), after: engineFigures(entry.after),
    }))
    const eventIds = row.kind === 'usage_correction'
      ? [...(payload.void ?? []).map((entry: Row) => entry.event_id), ...(payload.add ?? []).map((entry: Row) => entry.event_id)] : []
    const ownEvents = eventIds.length ? await all(env, `SELECT event_id,quantity FROM nc_usage_events WHERE customer_id=?
      AND event_id IN (${eventIds.map(() => '?').join(',')}) ORDER BY event_id`, session.customer, ...eventIds) : []
    const voids = new Set((payload.void ?? []).map((entry: Row) => entry.event_id))
    corrections.push({ id: row.id, kind: row.kind, periods,
      events: ownEvents.map(event => ({ eventId: event.event_id, quantity: event.quantity, action: voids.has(event.event_id) ? 'void' : 'add' })),
      message: { subject: row.subject, body: row.body, status: row.status },
      citations: periods.map((entry, index) => ({ source: `/portal/corrections/${encodeURIComponent(row.id)}`,
        recordPath: `/corrections/0/periods/${index}`,
        upcomingSource: `/portal/subscriptions/${encodeURIComponent(entry.subscription)}/upcoming?period=${entry.period.start.slice(0, 7)}`,
        period: entry.period, beforeFingerprint: entry.before.fingerprint, afterFingerprint: entry.after.fingerprint })) })
  }
  const historicalFilter=proposalId?' AND p.id=?':''
  for(const row of await all(env,`SELECT p.id,p.plan_json,m.subject,m.body,m.status FROM nc_usage_corrections p
    JOIN nc_usage_correction_mail m ON m.correction_id=p.id JOIN nc_customers c ON c.id=p.customer_id
    WHERE p.customer_id=? AND p.status='approved' AND c.erased_at IS NULL${historicalFilter} ORDER BY p.prepared_at,p.id`,...args)){
    const plan=parseJson<Row>(row.plan_json,{})
    const periods=plan.periods.map((p:Row)=>({subscription:plan.subscription,invoiceId:p.invoice,period:p.period,
      before:{...p.before,fingerprint:p.originalFingerprint,lines:p.beforeLines},after:{...p.after,fingerprint:p.fingerprint,lines:p.afterLines},
      delta:{subtotalCents:p.subtotalCents,taxCents:p.taxCents,totalCents:p.totalCents},eventIds:p.eventIds,
      credit:{amountCents:p.creditCents,appliedCents:p.appliedCents,carriedCents:p.carriedCents},revenue:p.postingRevenue}))
    corrections.push({id:row.id,kind:'historical_usage_correction',periods,message:{subject:row.subject,body:row.body,status:row.status},
      citations:periods.map((p:Row,index:number)=>({source:`/portal/corrections/${row.id}`,recordPath:`/corrections/0/periods/${index}`,invoiceSource:`/portal/invoices/${p.invoiceId}`}))})
  }
  if (proposalId) insist(corrections.length === 1, 'not_found', 404)
  return { corrections }
}
