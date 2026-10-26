import type { Bindings } from '../auth.server'
import type { Actor } from './actor'
import { clockInstant } from './clock'
import { commit,guard,insist,newId,stmt } from './core'
import { setupOwner,setupOwnerFence } from './hosted-setup-basis'
import type { Input } from './input'

export function retrySegmentLabel(value:string){
 insist(/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value),'retry_segment_invalid')
 return value
}
export async function assignRetrySegment(env:Bindings,actor:Actor,input:Input){
 const factor=await setupOwner(env,actor)
 input.only(['customer','customer_revision','revision','segment','confirm','returnTo'])
 insist(input.flag('confirm'),'retry_segment_confirmation_required')
 const customer=input.text('customer',{max:100}),customerRevision=input.text('customer_revision',{max:100}),prior=input.text('revision',{max:100,optional:true})
 const label=input.text('segment',{max:64,optional:true}),segment=label?retrySegmentLabel(label):null,revision=newId()
 await commit(env,[...setupOwnerFence(env,actor),
 guard(env,'retry_segment_customer_changed',"EXISTS(SELECT 1 FROM nc_customers WHERE id=? AND revision=? AND status='active' AND erased_at IS NULL) AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id=?)",customer,customerRevision,customer),
 guard(env,'retry_segment_changed',prior?'EXISTS(SELECT 1 FROM nc_retry_segments WHERE customer_id=? AND revision=?)':'NOT EXISTS(SELECT 1 FROM nc_retry_segments WHERE customer_id=?)',... (prior?[customer,prior]:[customer])),
 stmt(env,'INSERT INTO nc_retry_segments(customer_id,segment,revision,updated_by,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(customer_id) DO UPDATE SET segment=excluded.segment,revision=excluded.revision,updated_by=excluded.updated_by,updated_at=excluded.updated_at',customer,segment,revision,actor.id,clockInstant(env))],
 {actor:`member:${actor.id}`,action:'retry.segment.assign',subject:customer,detail:{segment,revision,factor}})
 return {customer,segment,revision}
}
