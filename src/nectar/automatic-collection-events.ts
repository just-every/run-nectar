// Authenticated event import fetches the provider event by id; supplied JSON is never trusted.
import type { Bindings } from '../auth.server'
import type { Actor } from './actor'
import { actorLabel } from './actor'
import { clockInstant } from './clock'
import { commit, guard, insist, NectarError, one, stmt } from './core'
import type { Input } from './input'
import { collectionAuthority, collectionOwner } from './movein/collection-state'
import { automaticView, storedAutomaticCollection } from './automatic-collection-records'
import { reconcileAutomaticCollection } from './automatic-collection-jobs'
import { providerReference, stripeForAccount } from './payments/stripe'
export async function checkAutomaticCollection(env:Bindings,actor:Actor,input:Input){
 await collectionOwner(env,actor)
 input.only(['request','returnTo'])
 return reconcileAutomaticCollection(env,input.text('request',{max:100}))
}
export async function consumeAutomaticEvent(env:Bindings,actor:Actor,input:Input){
 await collectionOwner(env,actor)
 input.only(['request','event_ref','returnTo'])
 return applyAutomaticEvent(env,input.text('request',{max:100}),providerReference(input.text('event_ref',{max:255})),actorLabel(actor),[collectionAuthority(env,actor)])
}

// A verified delivery observes an already claimed payment. It grants no write
// authority at the processor and never accepts a caller-supplied payment fact.
export async function applyAutomaticEvent(env:Bindings,id:string,eventRef:string,actor:string,authority:D1PreparedStatement[]=[]){
 const row=await storedAutomaticCollection(env,id)
 insist(row.claimed_at&&row.payment_intent_ref&&['claimed','uncertain','pending_settlement','refused','returned','collected'].includes(row.status),'automatic_collection_not_claimed',409)
 const prior=await one(env,'SELECT collection_id FROM nc_automatic_collection_events WHERE account_ref=? AND event_ref=?',row.account_ref,eventRef)
 if(prior){insist(prior.collection_id===row.id,'automatic_collection_event_mismatch',409);return {...await reconcileAutomaticCollection(env,row.id),replayed:true}}
 const {stripe}=await stripeForAccount(env,row.account_ref),event=await stripe(`/events/${encodeURIComponent(eventRef)}`),object=event.data?.object
 insist(event.object==='event'&&event.id===eventRef&&event.livemode===false&&['payment_intent.processing','payment_intent.succeeded','payment_intent.payment_failed'].includes(event.type)
 &&object?.object==='payment_intent'&&providerReference(object.id)===row.payment_intent_ref&&providerReference(object.customer)===row.stripe_customer_ref,'automatic_collection_event_mismatch',409)
 try{await commit(env,[...authority,guard(env,'customer_erased','EXISTS(SELECT 1 FROM nc_customers WHERE id=? AND erased_at IS NULL)',row.customer_id),
 stmt(env,'INSERT INTO nc_automatic_collection_events(account_ref,event_ref,customer_id,collection_id,received_at) VALUES(?,?,?,?,?)',row.account_ref,eventRef,row.customer_id,row.id,clockInstant(env))],
 {actor,action:'automatic.collection.event',subject:row.id,detail:{eventRef,eventType:event.type,invoice:row.invoice_id}})}catch(error){
  if(!(error instanceof NectarError&&error.code==='already_exists'))throw error
  const winner=await one(env,'SELECT collection_id FROM nc_automatic_collection_events WHERE account_ref=? AND event_ref=?',row.account_ref,eventRef)
  insist(winner?.collection_id===row.id,'automatic_collection_event_mismatch',409)
  return {...await reconcileAutomaticCollection(env,row.id),replayed:true}
 }
 return {...await reconcileAutomaticCollection(env,row.id),replayed:false}
}
