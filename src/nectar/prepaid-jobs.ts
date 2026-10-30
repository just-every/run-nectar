import { jobNeedsAttention } from './job-outcome'
import { runPrepaidTopups } from './prepaid-topup-jobs'
// Approved expiry/rollover and exact customer-authorized standing policies.
import type { Bindings } from '../auth.server'
import { one } from './core'
import { settlePrepaidScheduled } from './prepaid-issue'
export async function runPrepaidSettlement(env: Bindings) {
  const owner=await one(env,"SELECT m.* FROM nc_members m JOIN oa_operators o ON o.email=m.email WHERE m.role='owner' AND m.status='active' AND o.role='owner' AND o.status='active' ORDER BY m.id LIMIT 1")
  if(!owner)return {settled:[],deferred:[]}
  const actor={id:owner.id,kind:'member',role:'owner',name:owner.name,email:owner.email,sessionId:null,capabilities:new Set<import('./actor').Capability>(['read','settings'])} as import('./actor').Actor
  const settlement=await settlePrepaidScheduled(env,actor)
  const topups=await runPrepaidTopups(env,actor)
  return {...settlement,topups,status:topups.results.some(row=>jobNeedsAttention(row.status))?'failed':'completed'}
}
