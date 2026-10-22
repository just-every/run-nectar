import type {Bindings} from '../../auth.server'
import type {Actor} from '../actor'
import type {Row} from '../core'
import {hierarchyCreditModel} from '../hierarchy-credits'
import {cents,check,field,form,h,hidden,select,table} from './html'
export async function hierarchyCreditSection(env:Bindings,actor:Actor,invoice:Row){
 const m=await hierarchyCreditModel(env,actor,invoice);if(!m)return ''
 return h`<section class="card" aria-labelledby="hierarchy-credit"><h2 id="hierarchy-credit">Shared parent credit</h2><p>Apply ${m.parent.name}’s existing goodwill to this division invoice. This uses the parent’s remaining credit; it creates no new grant, changes no tax and sends no money. Above the credit limit, a different approver must confirm.</p>
 ${m.policy.two_person_above_cents!==null?h`<p>Current credit limit: ${cents(m.policy.two_person_above_cents)}.</p>`:''}
 ${table(['Amount$','Parent credit source','Prepared by','Reason','Status','Approval'],m.requests.map(r=>[cents(r.amount_cents),h`<a href="/app/customers/${m.parent.id}#balance-entry-${r.grant_id}">Original parent goodwill</a>`,r.prepared_name,r.reason,r.status,r.status==='pending'?(r.policy_revision!==m.policy.revision?'Policy changed; prepare a new request.':r.prepared_by_id===actor.id&&m.policy.two_person_above_cents!==null&&r.amount_cents>m.policy.two_person_above_cents?'A different owner or finance approver must apply this request.':form('hierarchy.credit.approve',`/app/invoices/${invoice.id}`,h`${hidden('request',r.id)}${check('I confirm this exact parent credit application.','confirm')}`,'Apply saved credit')):r.approval_mode]))}
 ${actor.role==='owner'&&invoice.balanceCents>0&&m.grants.length?form('hierarchy.credit.prepare',`/app/invoices/${invoice.id}`,h`${hidden('invoice',invoice.id)}${select('Parent goodwill grant','grant',m.grants.map(g=>({value:g.id,label:`${cents(g.remaining)} available · ${g.id}`})))}${field('Amount','amount')}${field('Reason','reason')}${check('The parent authorized this exact use of its credit.','consent')}`,'Prepare shared credit'):''}</section>`
}
