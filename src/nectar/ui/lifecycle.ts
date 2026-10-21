import type { Actor } from '../actor'
import { can } from '../actor'
import type { Row } from '../core'
import { formatDate } from '../dates'
import { check, field, form, h, hidden, select, table, who,cents } from './html'

export function lifecycleSection(s: Row, actor: Actor) {
  const back = `/app/subscriptions/${s.id}`
  const base = h`${hidden('subscription', s.id)}${hidden('revision', s.revision)}`
  const approve = actor.kind === 'member' && can(actor, 'approve')
  const pauses = s.lifecycle.filter((e: Row) => e.kind === 'pause' && !s.lifecycle.some((r: Row) => r.related_id === e.id))
  const currentTerm=s.renewal?.terms.find((t:Row)=>t.status==='active'&&!t.cancelled_at)
  const open=!s.end_date||!!currentTerm||!!s.contract_end_date&&!s.lifecycle.some((e:Row)=>e.kind==='cancel')
  const cancelled=s.lifecycle.some((e:Row)=>e.kind==='cancel'&&!s.lifecycle.some((c:Row)=>c.related_id===e.id))
  const policy=s.lifecyclePolicy
  return h`<section class="card" aria-labelledby="lifecycle"><h2 id="lifecycle">Lifecycle</h2>
    <p class="hint">Paused days have no charges. Usage remains recorded at zero. Choose whether the plan's access continues; billing resumes on the saved date.</p>
    ${table(['Change', 'Effective', 'Resume', 'Access', 'Reason', 'Recorded by'], s.lifecycle.map((e: Row) => [e.kind, formatDate(e.effective_date), formatDate(e.until_date), e.access, e.reason, who(actor,e.author)]), { empty: 'No lifecycle changes recorded.' })}
    ${approve && open ? form('subscription.pause', back, h`${base}${field('Pause from', 'effective_date', { type: 'date' })}${field('Resume on', 'resume_date', { type: 'date' })}${select('Access while paused', 'access', [{value:'suspend',label:'Suspend access'},{value:'retain',label:'Keep access'}], 'suspend')}${field('Reason', 'reason')}`, 'Pause subscription', {layout:'columns',secondary:true}) : ''}
    ${approve && open ? form('subscription.cancel',back,h`${base}${select('Cancel', 'mode',[{value:'immediate',label:'On the effective date'},{value:'term_end',label:currentTerm||s.contract_end_date?'At the contract term end':'At the monthly term end'}],'immediate')}${field('Effective date','effective_date',{type:'date'})}${field('Reason','reason')}`, 'Cancel subscription',{layout:'columns',secondary:true}) : ''}
    ${(s.cancellations??[]).map((request:Row)=>h`<article><h3>Unused advance-service cancellation · ${request.status}</h3><p>End service on ${request.effective_date}. Exact credit ${cents(request.plan?.plan?.amountCents??request.amountCents??0)}; issued originals remain unchanged.</p>${table(['Original invoice','Credit','Carried customer credit'],(request.plan?.plan?.credits??request.credits??[]).map((credit:Row)=>[h`<a href="/app/invoices/${credit.invoice}">${credit.number??credit.invoice}</a>`,cents(credit.amountCents),cents(credit.carriedCents??0)]))}${approve&&request.status==='pending'?h`${form('subscription.cancel.decide',back,h`${hidden('cancellation',request.id)}${hidden('decision','approved')}`,'Approve exact cancellation and credits')}${form('subscription.cancel.decide',back,h`${hidden('cancellation',request.id)}${hidden('decision','rejected')}`,'Reject cancellation',{secondary:true})}`:''}</article>`)}
    ${approve && cancelled ? form('subscription.reactivate',back,h`${base}${field('Reactivate on','effective_date',{type:'date'})}${field('Reason','reason')}`, 'Reactivate subscription',{layout:'columns',secondary:true}) : ''}
    <p class="hint">Cancellation ${policy.creditUnused ? 'credits unused recurring service on the final invoice' : 'bills the final recurring period without an unused-service credit'}. Reactivation is allowed within ${policy.reactivationDays} calendar days of cancellation, inclusive. A saved cancellation keeps the policy that applied to it.</p>
    ${actor.role==='owner' ? form('lifecycle.policy','/app/settings#policy-changes',h`${check('Credit unused recurring service','credit_unused',{checked:policy.creditUnused})}${field('Reactivation window (days)','reactivation_days',{type:'number',value:policy.reactivationDays})}`, 'Prepare lifecycle policy',{layout:'columns',secondary:true}) : ''}
    ${approve && pauses.length ? form('subscription.resume', back, h`${base}${select('Paused interval', 'pause', pauses.map((e: Row) => ({ value:e.id,label:`${formatDate(e.effective_date)} – ${formatDate(e.until_date)}` })), pauses[0].id)}${field('Resume earlier on', 'effective_date', {type:'date'})}${field('Reason', 'reason')}`, 'Resume subscription', {layout:'columns',secondary:true}) : ''}</section>`
}
