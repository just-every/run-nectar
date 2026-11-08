import type { Bindings } from '../auth.server'
import { guard, one } from './core'

const ACTIVE=`SELECT 1 FROM nc_portal_retention_authority a
  JOIN nc_retention_policies p ON p.id=a.policy_id AND p.status='approved'
  JOIN nc_members author ON author.id=p.prepared_by_id AND author.role='owner' AND author.status='active'
  JOIN nc_members approver ON approver.id=p.decided_by_id AND approver.role IN ('owner','finance') AND approver.status='active'
  WHERE a.policy_id=?`
export const portalRetentionActive=(env:Bindings,policy:string)=>one(env,ACTIVE,policy)
export const portalRetentionGuard=(env:Bindings,policy:string)=>guard(env,'retention_authority_unavailable',`EXISTS(${ACTIVE})`,policy)
