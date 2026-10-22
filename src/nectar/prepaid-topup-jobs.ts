// Runtime authority comes from the accepted exact policy, not a manufactured
// interactive factor. Crossing and monthly exposure are reserved atomically.
import type { Bindings } from '../auth.server'
import { actorLabel, type Actor } from './actor'
import { all, commit, guard, insist, newId, one, stmt } from './core'
import { clockInstant } from './clock'
import { prepaidFundingIntentStatements, prepaidRevisionGuard } from './prepaid-records'
import { chargePrepaidTopup } from './prepaid-topup-charge'
import { issueAuthorizedPrepaidTopupPurchase } from './prepaid-topup-purchase'
import { currentTopupAuthorization, topupAuthorizationGuard, topupRuntimeOwner } from './prepaid-topup-records'
export async function runPrepaidTopup(env:Bindings,actor:Actor,authorization:string){
  const owner=topupRuntimeOwner(env,actor),current=await currentTopupAuthorization(env,authorization),{row,q,basis,balance,date}=current
  const state=await one(env,'SELECT * FROM nc_prepaid_topup_states WHERE authorization_id=?',authorization)
  insist(state,'topup_state_not_found',409)
  const pending=await one(env,"SELECT * FROM nc_prepaid_topup_claims WHERE authorization_id=? AND status IN ('reserved','issued','claimed','uncertain') ORDER BY cycle LIMIT 1",authorization)
  if(pending){
    if(pending.status==='reserved'){await issueAuthorizedPrepaidTopupPurchase(env,actor,pending.id);return chargePrepaidTopup(env,actor,pending.id)}
    if(pending.status==='issued')return chargePrepaidTopup(env,actor,pending.id)
    return {id:pending.id,status:pending.status,noRetry:true}
  }
  if(balance>q.thresholdN){
    if(!state.armed)await commit(env,[owner,topupAuthorizationGuard(env,row),prepaidRevisionGuard(env,q.subscription,basis.revision),guard(env,'topup_state_changed','EXISTS(SELECT 1 FROM nc_prepaid_topup_states WHERE authorization_id=? AND revision=?)',authorization,state.revision),stmt(env,'UPDATE nc_prepaid_topup_states SET armed=1,revision=revision+1 WHERE authorization_id=?',authorization)],{actor:actorLabel(actor),action:'prepaid.topup.crossing.arm',subject:authorization,detail:{balanceN:balance}})
    return {authorization,status:'above_threshold',balanceN:balance}
  }
  insist(state.armed===1,'topup_crossing_already_claimed',409)
  const manual=await all(env,"SELECT id,invoice_id FROM nc_prepaid_funding_intents WHERE consent_id=? AND status='pending'",q.consent)
  insist(manual.every(intent=>!intent.invoice_id),'topup_manual_purchase_in_progress',409)
  const period=date.slice(0,7),id=newId(),funding=newId(),key=newId(),at=clockInstant(env)
  await commit(env,[owner,topupAuthorizationGuard(env,row),prepaidRevisionGuard(env,q.subscription,basis.revision),
    guard(env,'topup_state_changed','EXISTS(SELECT 1 FROM nc_prepaid_topup_states WHERE authorization_id=? AND armed=1 AND revision=? AND cycle=?)',authorization,state.revision,state.cycle),
    guard(env,'topup_monthly_cap',"COALESCE((SELECT SUM(amount_cents) FROM nc_prepaid_topup_claims WHERE authorization_id=? AND period=?),0)+?<=?",authorization,period,q.amountCents,q.periodCapCents),
    guard(env,'topup_unresolved_attempt',"NOT EXISTS(SELECT 1 FROM nc_prepaid_topup_claims WHERE authorization_id=? AND status IN ('reserved','issued','claimed','uncertain'))",authorization),
    guard(env,'topup_manual_purchase_in_progress',"NOT EXISTS(SELECT 1 FROM nc_prepaid_funding_intents WHERE consent_id=? AND status='pending' AND invoice_id IS NOT NULL)",q.consent),
    stmt(env,"UPDATE nc_prepaid_funding_intents SET status='cancelled' WHERE consent_id=? AND status='pending' AND invoice_id IS NULL",q.consent),
    ...prepaidFundingIntentStatements(env,funding,q.subscription,q.customer,{...q.terms,effectiveDate:date},q.request,null),
    stmt(env,"INSERT INTO nc_prepaid_topup_claims(id,authorization_id,customer_id,subscription_id,cycle,period,amount_cents,balance_n,funding_id,intent_key,status,claimed_at,revision) VALUES(?,?,?,?,?,?,?,?,?,?,'reserved',?,?)",id,authorization,q.customer,q.subscription,state.cycle+1,period,q.amountCents,balance,funding,key,at,newId()),
    stmt(env,'UPDATE nc_prepaid_topup_states SET armed=0,cycle=cycle+1,revision=revision+1 WHERE authorization_id=?',authorization)],{actor:actorLabel(actor),action:'prepaid.topup.crossing.claim',subject:id,detail:{authorization,basis:row.basis_hash,period,amountCents:q.amountCents,balanceN:balance,capCents:q.periodCapCents}})
  await issueAuthorizedPrepaidTopupPurchase(env,actor,id)
  return chargePrepaidTopup(env,actor,id)
}
export async function runPrepaidTopups(env:Bindings,actor:Actor){
  topupRuntimeOwner(env,actor)
  const authorizations=await all(env,"SELECT a.id FROM nc_prepaid_topup_authorizations a JOIN nc_customers c ON c.id=a.customer_id WHERE a.status='active' AND c.erased_at IS NULL ORDER BY a.id"),results=[]
  for(const row of authorizations){
    try{results.push(await runPrepaidTopup(env,actor,row.id))}catch(error){if(error instanceof Error&&'code' in error)results.push({authorization:row.id,status:'refused',error:(error as {code:unknown}).code});else throw error}
  }
  return {results}
}
