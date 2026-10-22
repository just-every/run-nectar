import type {Bindings} from '../../auth.server'
import type {Actor} from '../actor'
import type {Row} from '../core'
import {hierarchyCreditModel} from '../hierarchy-credits'
import {cents,check,field,form,h,hidden,select,table} from './html'
export async function hierarchyCreditSection(env:Bindings,actor:Actor,invoice:Row){
 const m=await hierarchyCreditModel(env,actor,invoice);if(!m)return ''
 return h`<section class="card" aria-labelledby="hierarchy-credit"><h2 id="hierarchy-credit">Shared parent credit</h2><p>Apply ${m.parent.name}’s existing goodwill to this division invoice. This uses the parent’s remaining credit; it creates no new grant, changes no tax and sends no money. Above the credit limit, a different approver must confirm.</p>
 ${table(['Amount$','Prepared by','Reason','Status','Approval'],m.requests.map(r=>[cents(r.amount_cents),r.prepared_name,r.reason,r.status,r.status==='pending'?form('hierarchy.credit.approve',`/app/invoices/${invoice.id}`,h`${hidden('request',r.id)}${check('I confirm this exact parent credit application.','confirm')}`,'Apply saved credit'):r.approval_mode]))}
 ${actor.role==='owner'&&invoice.balanceCents>0&&m.grants.length?form('hierarchy.credit.prepare',`/app/invoices/${invoice.id}`,h`${hidden('invoice',invoice.id)}${select('Parent goodwill grant','grant',m.grants.map(g=>({value:g.id,label:`${cents(g.remaining)} available · ${g.id}`})))}${field('Amount','amount')}${field('Reason','reason')}${check('The parent authorized this exact use of its credit.','consent')}`,'Prepare shared credit'):''}</section>`
}
