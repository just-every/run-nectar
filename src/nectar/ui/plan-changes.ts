import type { Actor } from '../actor'
import { can,canRead } from '../actor'
import type { Row } from '../core'
import { cents,field,form,h,hidden,select,table } from './html'

const policyLabel=(value:string|null)=>({invoice_now:'Prorate and invoice now',next_invoice:'Prorate on next invoice',none:'No proration'} as Record<string,string>)[value??'']??'Not configured'

export function planChangeSection(s: Row, actor: Actor, open: Row[], prices: Row[]) {
  const back=`/app/subscriptions/${s.id}`,policy=s.lifecyclePolicy?.prorationPolicy
  const preparing=(can(actor,'records')||can(actor,'draft'))&&canRead(actor,'subscriptions'),approving=actor.kind==='member'&&can(actor,'approve')
  return h`<section class="card" id="advance-plan-changes"><h2>Changes to issued advance plans</h2>
  <p>Immediate changes use today's business-local date. Period-end changes keep paid service through its existing end. The original invoice stays unchanged; a prorated debit or numbered credit records the difference. Payment always needs the owner's separate confirmation.</p>
  <p>Business proration policy: <strong>${policyLabel(policy)}</strong>. The owner prepares this policy under Lifecycle; a different approver confirms it.</p>
  ${(s.planChanges??[]).map((c:Row)=>h`<article><h3>${c.mode==='period_end'?'Period-end':'Immediate'} change · ${c.status}</h3><p>Target plan: <strong>${c.target_name??'Selected price'}${c.target_version?` v${c.target_version}`:''}</strong> · Quantity ${c.new_quantity}</p><p>Effective ${c.effective_date} · ${policyLabel(c.policy)}</p>${table(['Before$','After$','Debit / credit$'],[[cents(c.quote.before.totalCents),cents(c.quote.after.totalCents),cents(c.quote.delta.totalCents)]])}
  ${c.quote.waivedDelta?h`<p>No current-period proration. Quoted difference ${cents(c.quote.waivedDelta.totalCents)} is waived by the approved policy.</p>`:''}
  ${c.invoice_id?h`<p><a href="/app/invoices/${c.invoice_id}">Plan-change invoice</a></p>`:''}${c.credit_id?h`<p><a href="/app/invoices/${c.source_invoice_id}#credit-${c.credit_id}">Numbered plan-change credit</a></p>`:''}
  ${approving&&c.status==='pending'?h`${c.quote.delta.totalCents<0&&!c.creditRequest?form('plan.change.credit.prepare',back,hidden('change',c.id),'Prepare governed credit review'):c.prepared_by===actor.id||c.creditRequest?.requiresOther&&c.creditRequest.preparedBy===actor.id?h`<p>A different approver must approve this exact quote and credit.</p>`:form('plan.change.decide',back,h`${hidden('change',c.id)}${hidden('decision','approved')}`,'Approve plan and exact proration')}${form('plan.change.decide',back,h`${hidden('change',c.id)}${hidden('decision','rejected')}`,'Reject plan change',{secondary:true})}`:''}</article>`)}
  ${preparing&&policy&&open.length?form('plan.change.prepare',back,h`${hidden('subscription',s.id)}${select('Issued plan item','item',open.map(i=>({value:i.id,label:`${i.product_name} × ${i.quantity}`})))}${select('Target price','price',prices.map(p=>({value:p.id,label:`${p.name} ${p.nickname??''} v${p.version}`})))}${field('Seats (for seat plans)','quantity',{type:'number',value:1})}${select('When','mode',[{value:'immediate',label:'Immediately'},{value:'period_end',label:'At the paid period end'}])}`,'Preview issued-plan change',{layout:'columns'}):''}
  <p class="hint">Current issued-plan support is one fixed or seat advance component, including repeated governed changes in the same service period. Mixed service, prepaid and signed commitment corrections require further implementation and are refused.</p></section>`
}
