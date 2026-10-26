import type { Bindings } from '../auth.server'
import { actorLabel,requireMember,requireOwner,type Actor } from './actor'
import { clockInstant } from './clock'
import { commit,guard,insist,newId,one,stmt } from './core'
import type { Input } from './input'
import { requireFreshFactor,STEP_UP_MS } from './mfa'
import { currentLinkTerms,linkTermsGuards } from './payment-links'
export const otherLinkApprover="SELECT 1 FROM nc_members WHERE id<>? AND status='active' AND role IN ('owner','finance')"
export const linkApprovalSql=`JOIN nc_members preparer ON preparer.id=l.created_by AND preparer.status='active' AND preparer.role='owner'
 JOIN oa_operators po ON lower(po.email)=preparer.email AND po.status='active' AND po.role='owner'
 JOIN nc_members approver ON approver.id=l.approved_by AND approver.status='active' AND approver.role IN ('owner','finance')
 JOIN oa_operators ao ON lower(ao.email)=approver.email AND ao.status='active'`
export async function approvePaymentLink(env:Bindings,actor:Actor,input:Input){
 requireMember(actor,'approve');await requireFreshFactor(env,actor)
 input.only(['link','basis_hash','decision','confirm','confirm_single','returnTo'])
 const row=await one(env,'SELECT * FROM nc_payment_links WHERE id=?',input.text('link',{max:100})),decision=input.text('decision',{max:10})
 insist(row&&row.approval_status==='pending'&&row.basis_hash===input.text('basis_hash',{max:100})&&input.flag('confirm')&&['approved','rejected'].includes(decision),'payment_link_approval_changed',409)
 const terms=await currentLinkTerms(env,row,false),single=row.created_by===actor.id
 if(single){requireOwner(actor);insist(input.flag('confirm_single')&&!await one(env,otherLinkApprover,actor.id),'second_approver_required',409)}
 const at=clockInstant(env)
 await commit(env,[...linkTermsGuards(env,terms),guard(env,'payment_link_approval_changed',"EXISTS(SELECT 1 FROM nc_payment_links WHERE id=? AND basis_hash=? AND approval_status='pending' AND revision=?)",row.id,row.basis_hash,row.revision),
  guard(env,'preparer_inactive',"EXISTS(SELECT 1 FROM nc_members m JOIN oa_operators o ON lower(o.email)=m.email WHERE m.id=? AND m.role='owner' AND m.status='active' AND o.role='owner' AND o.status='active')",row.created_by),
  guard(env,'forbidden',"EXISTS(SELECT 1 FROM nc_members WHERE id=? AND status='active' AND role IN ('owner','finance'))",actor.id),
  guard(env,'mfa_step_up_required',"EXISTS(SELECT 1 FROM nc_mfa_sessions WHERE session_id=? AND member_id=? AND method IN ('totp','passkey') AND verified_at BETWEEN ? AND ?)",actor.sessionId,actor.id,at-STEP_UP_MS,at),
  ...(single?[guard(env,'second_approver_required',`NOT EXISTS(${otherLinkApprover})`,actor.id)]:[]),
  stmt(env,"UPDATE nc_payment_links SET approval_status=?,approved_by=?,approved_at=?,approval_mode=?,revision=? WHERE id=?",decision,actor.id,at,single?'single-approver':'two-person',newId(),row.id)],
 {actor:actorLabel(actor),action:`payment_link.${decision}`,subject:row.id,detail:{basis:row.basis_hash,preparedBy:row.created_by,approvalMode:single?'single-approver':'two-person'}})
 return {id:row.id}
}
