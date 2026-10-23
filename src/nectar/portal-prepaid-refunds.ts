import type { Bindings } from '../auth.server'
import { all } from './core'
import { decimalText } from './decimal'
import { customerText } from './locale'
import type { PortalPrepaidLot } from './portal-prepaid'
import type { CustomerSession } from './portal-session'
import { h } from './ui/html'

export async function portalRefundSection(env:Bindings,session:CustomerSession,lots:PortalPrepaidLot[],link:(path:string)=>string){
  const L=customerText(session.language)
  const requests=await all(env,`SELECT t.id,t.grant_id,t.amount_n,t.amount_cents,t.kind,COALESCE(r.status,'pending') AS status FROM nc_prepaid_refund_intakes t LEFT JOIN nc_prepaid_refunds r ON r.id=t.id WHERE t.customer_id=? ORDER BY t.requested_at,t.id`,session.customer)
  const active=await all(env,"SELECT grant_id FROM nc_prepaid_refunds WHERE customer_id=? AND status IN ('pending','approved','claimed','uncertain') UNION SELECT grant_id FROM nc_prepaid_refund_intakes WHERE customer_id=? AND status='pending'",session.customer,session.customer)
  return h`<section class="card"><h2>${L.t('portal.refund.heading')}</h2><p>${L.t('portal.refund.body')}</p>
    ${requests.map(row=>h`<p>${row.id} · ${L.t(`portal.refund.status.${row.status}`)} · ${L.money(row.amount_cents)}${row.kind==='units'?h` · ${L.percent(decimalText(BigInt(row.amount_n)))} ${L.t('portal.prepaid.units')}`:''}</p>`)}
    ${lots.filter(lot=>lot.source==='purchase'&&lot.availableN>0&&!active.some(row=>`prepaid-${row.grant_id}`===lot.id)).map(lot=>h`<form method="post" action="${link('/portal/prepaid-refund.request')}"><input type="hidden" name="grant" value="${lot.id.slice('prepaid-'.length)}"><p>${lot.purchaseInvoice?.number} · ${L.money(lot.liabilityCents)}</p><button>${L.t('portal.refund.request')}</button></form>`)}</section>`
}
