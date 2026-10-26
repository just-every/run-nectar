import type { Bindings } from '../../auth.server'
import type { Actor } from '../actor'
import { all } from '../core'
import { h,field,form,check,table } from './html'
export async function retrySettings(env:Bindings,actor:Actor){
 if(actor.role!=='owner')return ''
 const policies=await all(env,'SELECT * FROM nc_retry_policies ORDER BY scope')
 return h`<section class="card" id="payment-retries"><h2>Payment retries</h2><p>Retries are off unless included in the exact invoice terms accepted by the customer and approved by a person. Existing consent keeps its frozen policy.</p>${table(['Scope','Total attempts','Window in days'],policies.map(p=>[p.scope,p.max_attempts,p.window_days]))}<details><summary>Change retry limits</summary>${form('retry.policy.configure','/app/settings#payment-retries',h`${field('Plan price reference, blank for default','plan',{required:false})}${field('Maximum total attempts','max_attempts',{type:'number',value:'8'})}${field('Window in days','window_days',{type:'number',value:'14'})}${check('I confirm these limits for future customer consent','confirm')}`,'Apply retry limits',{secondary:true})}</details></section>`
}
