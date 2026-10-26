// Authenticated event import fetches the provider event by id; supplied JSON is never trusted.
import type { Bindings } from '../auth.server'
import type { Actor } from './actor'
import { actorLabel } from './actor'
import { clockInstant } from './clock'
import { commit, guard, insist, one, stmt } from './core'
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
 const row=await storedAutomaticCollection(env,input.text('request',{max:100})),eventRef=providerReference(input.text('event_ref',{max:255}))
 const prior=await one(env,'SELECT collection_id FROM nc_automatic_collection_events WHERE account_ref=? AND event_ref=?',row.account_ref,eventRef)
 if(prior){insist(prior.collection_id===row.id,'automatic_collection_event_mismatch',409);return {...await reconcileAutomaticCollection(env,row.id),replayed:true}}
 const {stripe}=await stripeForAccount(env,row.account_ref),event=await stripe(`/events/${encodeURIComponent(eventRef)}`),object=event.data?.object
 insist(event.object==='event'&&event.id===eventRef&&event.livemode===false&&['payment_intent.processing','payment_intent.succeeded','payment_intent.payment_failed'].includes(event.type)
 &&object?.object==='payment_intent'&&providerReference(object.id)===row.payment_intent_ref&&providerReference(object.customer)===row.stripe_customer_ref,'automatic_collection_event_mismatch',409)
 await commit(env,[collectionAuthority(env,actor),guard(env,'customer_erased','EXISTS(SELECT 1 FROM nc_customers WHERE id=? AND erased_at IS NULL)',row.customer_id),
 stmt(env,'INSERT INTO nc_automatic_collection_events(account_ref,event_ref,customer_id,collection_id,received_at) VALUES(?,?,?,?,?)',row.account_ref,eventRef,row.customer_id,row.id,clockInstant(env))],
 {actor:actorLabel(actor),action:'automatic.collection.event',subject:row.id,detail:{eventRef,eventType:event.type,invoice:row.invoice_id}})
 return {...await reconcileAutomaticCollection(env,row.id),replayed:false}
}
