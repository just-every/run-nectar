import { upcoming } from './upcoming'
// DEV-006: explicit owner-confirmed, test-mode app writes to the biller that
// still owns a shadow subscription. A claimed POST is never automatically retried.
import type { Bindings } from '../auth.server'
import { actorLabel, type Actor } from './actor'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { all, canonical, commit, guard, insist, newId, one, parseJson, stmt, type Row } from './core'
import { localDate, today } from './dates'
import type { Input } from './input'
import { collectionAuthority, collectionOwner } from './movein/collection-state'
import { providerReference, providerUnavailable, stripeForAccount } from './payments/stripe'

const ref=(value:unknown):string=>typeof value==='string'?value:value&&typeof value==='object'?String((value as Row).id??''):''
function projection(source:Row,provider:string,customer:string) {
  insist(source.object==='subscription'&&source.id===provider&&ref(source.customer)===customer&&source.livemode===false&&['active','trialing','past_due'].includes(source.status),'stripe_test_shadow_subscription_required',409)
  insist(source.items?.object==='list'&&source.items.has_more===false&&Array.isArray(source.items.data)&&source.items.data.length>0&&source.items.data.length<=20,'shadow_items_incomplete',409)
  const items=source.items.data.map((item:Row)=>{
    insist(Number.isSafeInteger(item.quantity)&&item.quantity>=1&&item.quantity<=1000000,'shadow_quantity_unsupported',409)
    return {id:providerReference(item.id),price:providerReference(ref(item.price)),quantity:item.quantity}
  }).sort((a:Row,b:Row)=>a.id.localeCompare(b.id))
  insist(new Set(items.map((i:Row)=>i.id)).size===items.length,'shadow_items_incomplete',409)
  const end=source.current_period_end??source.items.data[0].current_period_end
  insist(Number.isSafeInteger(end)&&end>0,'shadow_period_end_required',409)
  return {status:source.status,items,cancel_at_period_end:source.cancel_at_period_end===true,period_end:end,
    paused:source.pause_collection!==null&&source.pause_collection!==undefined}
}
async function shadow(env:Bindings,id:string) {
  const row=await one(env,`SELECT s.*,c.provider_ref customer_ref,c.revision customer_revision FROM nc_subscriptions s JOIN nc_customers c ON c.id=s.customer_id
    WHERE s.id=? AND s.origin='import' AND s.billing_mode='shadow' AND c.status='active' AND c.erased_at IS NULL`,id)
  insist(row&&!await one(env,'SELECT 1 FROM nc_erased_records WHERE record_id IN (?,?)',row.id,row.customer_id),'shadow_subscription_required',409)
  return row
}
async function liveSource(env:Bindings,row:Row,account:string) {
  const selected=await stripeForAccount(env,account).catch(providerUnavailable)
  const source=await selected.stripe(`/subscriptions/${encodeURIComponent(providerReference(row.provider_ref))}`).catch(providerUnavailable)
  return {...selected,source,state:projection(source,row.provider_ref,row.customer_ref)}
}
const publicChange=(row:Row)=>({id:row.id,subscription:row.subscription_id,status:row.status,quantity:row.quantity,cancel_at_period_end:row.cancel_at_period_end===null?null:!!row.cancel_at_period_end,prepared_at:row.prepared_at,applied_at:row.applied_at??null})
const localGuard=(env:Bindings,row:Row)=>guard(env,'shadow_local_source_changed',`EXISTS(SELECT 1 FROM nc_subscriptions s JOIN nc_customers c ON c.id=s.customer_id WHERE s.id=? AND s.revision=? AND s.billing_mode='shadow' AND c.id=? AND c.revision=? AND c.erased_at IS NULL AND c.status='active')`,row.subscription_id,row.subscription_revision,row.customer_id,row.customer_revision)

export async function prepareShadowAppChange(env:Bindings,actor:Actor,input:Input) {
  await collectionOwner(env,actor)
  input.only(['subscription','account_ref','item','quantity','cancel_at_period_end','returnTo'])
  const sub=await shadow(env,input.text('subscription',{max:100})),account=providerReference(input.text('account_ref',{max:255}))
  const quantity=input.integer('quantity',{min:1,max:1000000,optional:true}),cancel=input.has('cancel_at_period_end')?input.json('cancel_at_period_end'):null
  insist(cancel===null||typeof cancel==='boolean','invalid_cancel_at_period_end')
  insist(quantity!==null||cancel!==null,'shadow_change_required')
  const item=quantity!==null?await one(env,'SELECT * FROM nc_items WHERE id=? AND subscription_id=? AND effective_to IS NULL',input.text('item',{max:100}),sub.id):null
  insist(quantity===null||item?.origin==='import'&&item.provider_ref,'shadow_item_required',409)
  const {state}=await liveSource(env,sub,account)
  insist(!state.paused,'shadow_paused_subscription',409)
  const business=await requireBusiness(env)
  insist(sub.end_date===(state.cancel_at_period_end?localDate(state.period_end*1000,business.timezone):null),'shadow_snapshot_stale',409)
  const current=(await all(env,`SELECT i.provider_ref id,p.provider_ref price,i.quantity FROM nc_items i JOIN nc_prices p ON p.id=i.price_id WHERE i.subscription_id=? AND i.effective_to IS NULL ORDER BY i.provider_ref`,sub.id))
  insist(canonical(current)===canonical(state.items),'shadow_snapshot_stale',409)
  if(item&&item.quantity!==quantity)insist((await one(env,'SELECT kind FROM nc_prices WHERE id=?',item.price_id))?.kind==='seat','shadow_price_not_quantity_based',409)

  if(item){const found=state.items.find((i:Row)=>i.id===item.provider_ref);const price=await one(env,'SELECT provider_ref FROM nc_prices WHERE id=?',item.price_id)
    insist(found&&found.quantity===item.quantity&&found.price===price?.provider_ref,'shadow_snapshot_stale',409)}
  const id=newId(),at=clockInstant(env)
  await commit(env,[collectionAuthority(env,actor),
    guard(env,'shadow_local_source_changed',"EXISTS(SELECT 1 FROM nc_subscriptions WHERE id=? AND revision=? AND billing_mode='shadow') AND EXISTS(SELECT 1 FROM nc_customers WHERE id=? AND revision=? AND erased_at IS NULL)",sub.id,sub.revision,sub.customer_id,sub.customer_revision),
    stmt(env,`INSERT INTO nc_shadow_app_changes(id,customer_id,subscription_id,account_ref,provider_ref,customer_ref,item_id,provider_item_ref,quantity,cancel_at_period_end,customer_revision,subscription_revision,before_json,prepared_by,prepared_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,id,sub.customer_id,sub.id,account,sub.provider_ref,sub.customer_ref,item?.id??null,item?.provider_ref??null,quantity,cancel===null?null:cancel?1:0,sub.customer_revision,sub.revision,JSON.stringify(state),actor.id,at),
  ],{actor:actorLabel(actor),action:'shadow.app.prepare',subject:id,detail:{subscription:sub.id,account,quantity,cancel_at_period_end:cancel,source:state}})
  return {id,subscription:sub.id,status:'prepared',before:state,quantity,cancel_at_period_end:cancel}
}
async function request(env:Bindings,actor:Actor,input:Input) {
  await collectionOwner(env,actor)
  const row=await one(env,'SELECT * FROM nc_shadow_app_changes WHERE id=?',input.text('change',{max:100}))
  insist(row,'shadow_change_not_found',404)
  await shadow(env,row.subscription_id)
  return row
}
function desired(row:Row,state:ReturnType<typeof projection>) {
  const before=parseJson<Row>(row.before_json,{})
  const expected={...before,items:before.items.map((i:Row)=>i.id===row.provider_item_ref?{...i,quantity:row.quantity}:i),
    cancel_at_period_end:row.cancel_at_period_end===null?before.cancel_at_period_end:!!row.cancel_at_period_end}
  return canonical(state)===canonical(expected)
}
async function applyObserved(env:Bindings,actor:Actor,row:Row,source:Row) {
  const state=projection(source,row.provider_ref,row.customer_ref)
  insist(source.metadata?.nectar_shadow_change===row.id&&desired(row,state),'shadow_change_unconfirmed',409)
  const business=await requireBusiness(env),at=clockInstant(env),date=localDate(at,business.timezone)
  const statements=[collectionAuthority(env,actor),localGuard(env,row),guard(env,'shadow_change_already_observed',"EXISTS(SELECT 1 FROM nc_shadow_app_changes WHERE id=? AND status IN ('sending','uncertain'))",row.id)]
  if(row.item_id){
    const item=await one(env,'SELECT * FROM nc_items WHERE id=? AND subscription_id=?',row.item_id,row.subscription_id)
    const before=parseJson<Row>(row.before_json,{}).items.find((i:Row)=>i.id===row.provider_item_ref)
    insist(item&&item.quantity===before.quantity&&item.effective_to===null&&item.effective_from<=date,'shadow_local_source_changed',409)
    if(item.effective_from===date){
      // Same-day source state has no prior service interval. The immutable
      // import original and prepared before-image retain the previous value.
      statements.push(stmt(env,'UPDATE nc_items SET quantity=? WHERE id=?',row.quantity,item.id))
    }else{
      statements.push(stmt(env,'UPDATE nc_items SET effective_to=? WHERE id=?',date,item.id),
        stmt(env,"INSERT INTO nc_items(id,subscription_id,price_id,quantity,effective_from,effective_to,origin,provider_ref,created_at) VALUES(?,?,?,?,?,NULL,'import',?,?)",newId(),row.subscription_id,item.price_id,row.quantity,date,row.provider_item_ref,at))
    }
  }
  const end=state.cancel_at_period_end?localDate(state.period_end*1000,business.timezone):null
  statements.push(stmt(env,'UPDATE nc_subscriptions SET end_date=?,revision=?,updated_at=? WHERE id=?',end,newId(),at,row.subscription_id),
    stmt(env,"UPDATE nc_shadow_app_changes SET status='applied',applied_at=?,result_json=? WHERE id=?",at,JSON.stringify(state),row.id))
  await commit(env,statements,{actor:actorLabel(actor),action:'shadow.app.observe',subject:row.id,detail:{subscription:row.subscription_id,source:state,custody:'stripe-test-observed-no-proration'}})
  return {...publicChange(row),status:'applied',applied_at:at,source:state}
}
export async function confirmShadowAppChange(env:Bindings,actor:Actor,input:Input) {
  const row=await request(env,actor,input)
  input.only(['change','confirm','returnTo'])
  insist(input.flag('confirm'),'shadow_change_confirmation_required')
  if(row.status==='applied')return publicChange(row)
  insist(row.status==='prepared','shadow_change_requires_reconciliation',409)
  const sub=await shadow(env,row.subscription_id),{stripe,state}=await liveSource(env,sub,row.account_ref)
  insist(canonical(state)===canonical(parseJson(row.before_json,{})),'shadow_provider_source_changed',409)
  const at=clockInstant(env)
  await commit(env,[collectionAuthority(env,actor),localGuard(env,row),
    guard(env,'shadow_change_already_claimed',"EXISTS(SELECT 1 FROM nc_shadow_app_changes WHERE id=? AND status='prepared') AND NOT EXISTS(SELECT 1 FROM nc_shadow_app_changes WHERE subscription_id=? AND id<>? AND status IN ('sending','uncertain'))",row.id,row.subscription_id,row.id),
    stmt(env,"UPDATE nc_shadow_app_changes SET status='sending',claimed_at=? WHERE id=?",at,row.id),
  ],{actor:actorLabel(actor),action:'shadow.app.confirm',subject:row.id,detail:{subscription:row.subscription_id,confirm:true}})
  const fields=new URLSearchParams({'metadata[nectar_shadow_change]':row.id})
  if(row.quantity!==null){fields.set('items[0][id]',row.provider_item_ref);fields.set('items[0][quantity]',String(row.quantity));fields.set('proration_behavior','none')}
  if(row.cancel_at_period_end!==null)fields.set('cancel_at_period_end',row.cancel_at_period_end?'true':'false')
  let response:Row
  try{response=await stripe(`/subscriptions/${encodeURIComponent(row.provider_ref)}`,fields,`nectar-shadow-${row.id}`)}
  catch{
    await commit(env,[stmt(env,"UPDATE nc_shadow_app_changes SET status='uncertain' WHERE id=? AND status='sending'",row.id)],{actor:actorLabel(actor),action:'shadow.app.uncertain',subject:row.id,detail:{subscription:row.subscription_id}})
    return {...publicChange(row),status:'uncertain',recovery:'GET-only reconciliation; no repeated provider POST'}
  }
  return await applyObserved(env,actor,row,response)
}
export async function reconcileShadowAppChange(env:Bindings,actor:Actor,input:Input) {
  const row=await request(env,actor,input)
  input.only(['change','returnTo'])
  if(row.status==='applied')return publicChange(row)
  insist(['sending','uncertain'].includes(row.status),'shadow_change_not_claimed',409)
  const {stripe}=await stripeForAccount(env,row.account_ref).catch(providerUnavailable)
  const source=await stripe(`/subscriptions/${encodeURIComponent(row.provider_ref)}`).catch(providerUnavailable)
  return await applyObserved(env,actor,row,source)
}
export async function shadowInvoicePreview(env:Bindings,actor:Actor,input:Input) {
  await collectionOwner(env,actor)
  input.only(['subscription','account_ref','returnTo'])
  const sub=await shadow(env,input.text('subscription',{max:100})),account=providerReference(input.text('account_ref',{max:255}))
  const {stripe}=await liveSource(env,sub,account)
  const preview=await stripe('/invoices/create_preview',new URLSearchParams({subscription:sub.provider_ref,customer:sub.customer_ref})).catch(providerUnavailable)
  insist(preview.object==='invoice'&&ref(preview.customer)===sub.customer_ref&&preview.livemode===false&&/^[a-z]{3}$/.test(preview.currency)&&[preview.subtotal,preview.total,preview.amount_due].every(Number.isSafeInteger),'shadow_preview_invalid',409)
  // A preview is a quote: no invoice, collection, email or source response body
  // is saved, and provider contact fields/narratives are never returned.
  return {subscription:sub.id,customer:sub.customer_id,source:'stripe-test-preview',currency:preview.currency,subtotalCents:preview.subtotal,totalCents:preview.total,amountDueCents:preview.amount_due}
}

/** One app call chooses the biller from the subscription's recorded custody. */
export async function appInvoicePreview(env:Bindings,actor:Actor,input:Input) {
  await collectionOwner(env,actor)
  input.only(['subscription','account_ref','period','returnTo'])
  const id=input.text('subscription',{max:100}),period=input.text('period',{max:7,optional:true})
  const sub=await one(env,`SELECT s.*,c.erased_at,c.status customer_status FROM nc_subscriptions s JOIN nc_customers c ON c.id=s.customer_id WHERE s.id=?`,id)
  insist(sub&&sub.erased_at===null&&sub.customer_status==='active','subscription_not_found',404)
  if(sub.billing_mode==='shadow'){
    insist(!period,'shadow_preview_current_only',409)
    const source=await shadow(env,id),account=providerReference(input.text('account_ref',{max:255})),{stripe}=await liveSource(env,source,account)
    const quote=await stripe('/invoices/create_preview',new URLSearchParams({subscription:source.provider_ref,customer:source.customer_ref})).catch(providerUnavailable)
    insist(quote.object==='invoice'&&ref(quote.customer)===source.customer_ref&&quote.livemode===false&&/^[a-z]{3}$/.test(quote.currency)&&[quote.subtotal,quote.total,quote.amount_due].every(Number.isSafeInteger),'shadow_preview_invalid',409)
    return {subscription:id,customer:source.customer_id,source:'stripe-test-preview',currency:quote.currency,subtotalCents:quote.subtotal,totalCents:quote.total,amountDueCents:quote.amount_due}
  }
  const business=await requireBusiness(env),day=today(business.timezone,clockInstant(env))
  const selected=period||(sub.cutover_start&&day<sub.cutover_start?sub.cutover_start.slice(0,7):undefined)
  const quote=await upcoming(env,actor,id,selected)
  return {subscription:id,customer:sub.customer_id,source:'nectar-preview',currency:business.currency,subtotalCents:quote.calculation.subtotalCents,totalCents:quote.calculation.totalCents,amountDueCents:quote.balanceAfterCreditsCents,period:quote.period}
}
