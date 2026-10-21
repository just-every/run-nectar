// Restart credited advance service through the ordinary native item calendar.
// Issued items keep their original evidence and claims; new items own only
// the reinstated service and receive normal invoice approval and issue.
import type { Bindings } from '../auth.server'
import { all, guard, insist, newId, now, one, parseJson, stmt, type Row } from './core'
import { cancellationPlan } from './interval-cancel-plan'
import { cancellationIssuedGuard } from './interval-cancel'

export async function intervalReactivationStatements(env: Bindings, sub: Row, canceled: Row, date: string) {
  const term = await one(env, "SELECT * FROM nc_renewal_terms WHERE subscription_id=? AND status='active' AND cancelled_at IS NULL AND start_date<=? AND end_date>?", sub.id, date, date)
  insist(!sub.contract_end_date || date < sub.contract_end_date || term, 'approved_renewal_required', 409)
  const source = await cancellationPlan(env, sub.id, date, canceled.id, false)
  const statements = [cancellationIssuedGuard(env, sub.id, date, source.invoices)]
  const corrections = await all(env, "SELECT plan_json FROM nc_interval_cancellations WHERE transition_id=? AND status='approved'", canceled.id)
  const restored = []
  for (const correction of corrections) {
    const saved = parseJson<Row>(correction.plan_json, {})
    const ids = [...new Set<string>(saved.plan.credits.flatMap((credit: Row) => credit.calendar.components.map((component: Row) => component.itemId)))]
    for (const id of ids) {
      const item = await one(env, 'SELECT * FROM nc_items WHERE id=? AND subscription_id=?', id, sub.id)
      insist(item && item.effective_from < canceled.effective_date, 'advance_restart_source_required', 409)
      const to = item.effective_to === sub.contract_end_date && term ? term.end_date : item.effective_to
      if (to && to <= date) continue
      const replacement = newId()
      statements.push(
        guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_items WHERE id=? AND price_id=? AND quantity=? AND effective_from=? AND effective_to IS ?)', item.id, item.price_id, item.quantity, item.effective_from, item.effective_to),
        stmt(env, 'UPDATE nc_items SET effective_to=? WHERE id=?', canceled.effective_date, item.id),
        stmt(env, "INSERT INTO nc_items(id,subscription_id,price_id,quantity,effective_from,effective_to,origin,created_at) VALUES(?,?,?,?,?,?,'native',?)", replacement, sub.id, item.price_id, item.quantity, date, to, now()))
      restored.push({ originalItem: item.id, item: replacement, price: item.price_id, quantity: item.quantity, from: date, to })
    }
  }
  // A governed renewal may extend only the old co-termed ending; an explicit
  // earlier item ending remains part of the signed timeline.
  if (term && sub.contract_end_date && date >= sub.contract_end_date) {
    statements.push(guard(env, 'stale', "EXISTS(SELECT 1 FROM nc_renewal_terms WHERE id=? AND revision=? AND status='active' AND cancelled_at IS NULL)", term.id, term.revision),
      stmt(env, 'UPDATE nc_items SET effective_to=? WHERE subscription_id=? AND effective_to=?', term.end_date, sub.id, sub.contract_end_date))
  }
  return { statements, restored, term, contractEnd: term?.end_date ?? sub.contract_end_date }
}
