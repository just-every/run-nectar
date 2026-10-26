import { setupOwner,setupOwnerFence } from './hosted-setup-basis'
// Nectar owns the schedule; no provider billing retry service is invoked.
import type { Bindings } from '../auth.server'
import type { Actor } from './actor'
import { clockInstant } from './clock'
import { all,commit,insist,one,stmt } from './core'
import type { Input } from './input'
import { HARD_CARD_DECLINES } from './card-lifecycle'
export const RETRY_TABLE_VERSION='nectar-declines-2026-10-27'
export const DAY=86400000
export const bankReturnCode=(code:string):string=>code==='insufficient_funds'?'ach_insufficient_funds':code
export interface RetryPolicy {version:string;maxAttempts:number;windowDays:number;scope:string}
export const RETRY_DELAYS:Record<string,number>={processing_error:4*3600000,do_not_honor:DAY,insufficient_funds:3*DAY,R01:3*DAY,R09:3*DAY,ach_insufficient_funds:3*DAY}
export function nextRetry(code:string,method:string,attempts:number,failedAt:number,firstFailedAt:number,policy:RetryPolicy){
 if(HARD_CARD_DECLINES.has(code)||!Object.hasOwn(RETRY_DELAYS,code))return null
 if(method==='us_bank_account'&&!['R01','R09','ach_insufficient_funds'].includes(code))return null
 if(attempts>=Math.min(policy.maxAttempts,method==='us_bank_account'?3:8))return null
 const next=failedAt+RETRY_DELAYS[code],end=firstFailedAt+Math.min(policy.windowDays,method==='us_bank_account'?180:14)*DAY
 return next<=end?next:null
}
export async function selectedRetryPolicy(env:Bindings,invoice:{id?:string;subscription_id?:string|null},method='card'){
 const plans=invoice.subscription_id?await all(env,`SELECT DISTINCT p.* FROM nc_retry_policies p JOIN nc_invoice_lines i ON p.scope='plan:'||i.price_id WHERE i.invoice_id=? ORDER BY p.scope`,invoice.id):[]
 const row=plans.length?{scope:plans.map(p=>p.scope).join(', '),max_attempts:Math.min(...plans.map(p=>p.max_attempts)),window_days:Math.min(...plans.map(p=>p.window_days))}:await one(env,"SELECT * FROM nc_retry_policies WHERE scope='default'")
 return {version:RETRY_TABLE_VERSION,maxAttempts:row?.max_attempts??(method==='us_bank_account'?3:8),windowDays:row?.window_days??(method==='us_bank_account'?40:14),scope:row?.scope??'default'} as RetryPolicy
}
export async function configureRetryPolicy(env:Bindings,actor:Actor,input:Input){
 const factor=await setupOwner(env,actor);input.only(['plan','max_attempts','window_days','confirm','returnTo'])
 insist(input.flag('confirm'),'retry_policy_confirmation_required')
 const plan=input.text('plan',{max:100,optional:true});if(plan)insist(await one(env,'SELECT 1 FROM nc_prices WHERE id=?',plan),'plan_not_found',404)
 const count=input.integer('max_attempts',{min:1,max:8})!,days=input.integer('window_days',{min:1,max:14})!,scope=plan?`plan:${plan}`:'default',at=clockInstant(env)
 await commit(env,[...setupOwnerFence(env,actor),stmt(env,'INSERT INTO nc_retry_policies(scope,max_attempts,window_days,updated_by,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(scope) DO UPDATE SET max_attempts=excluded.max_attempts,window_days=excluded.window_days,updated_by=excluded.updated_by,updated_at=excluded.updated_at',scope,count,days,actor.id,at)],{actor:`member:${actor.id}`,action:'retry.policy.configure',subject:scope,detail:{maxAttempts:count,windowDays:days,version:RETRY_TABLE_VERSION,factor}})
 return {scope,maxAttempts:count,windowDays:days,version:RETRY_TABLE_VERSION}
}
