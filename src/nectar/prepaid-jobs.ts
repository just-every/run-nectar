// Approved expiry/rollover only; automatic provider charging is absent.
import type { Bindings } from '../auth.server'
import { one } from './core'
import { settlePrepaidScheduled } from './prepaid-issue'
export async function runPrepaidSettlement(env: Bindings) {
  const owner=await one(env,"SELECT m.* FROM nc_members m JOIN oa_operators o ON o.email=m.email WHERE m.role='owner' AND m.status='active' AND o.role='owner' AND o.status='active' ORDER BY m.id LIMIT 1")
  if(!owner)return {settled:[],deferred:[]}
  return settlePrepaidScheduled(env,{id:owner.id,kind:'member',role:'owner',name:owner.name,email:owner.email,sessionId:null,capabilities:new Set(['read','settings'])})
}
