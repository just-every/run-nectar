import assert from 'node:assert/strict'
import { nativeCollectionEdge } from './native-collection.mjs'
import { totp } from './mfa.mjs'

function lifecycleEdge() {
  const base=nativeCollectionEdge(),events=new Map(),methods=new Map(),calls=[]
  let stolen=false
  const account='synthetic-nectar-native-account-1',customer='synthetic-nectar-native-customer-1',method='synthetic-nectar-native-card-1'
  const card=(id=method,owner=customer,details={})=>({object:'payment_method',id,customer:owner,type:'card',livemode:false,
    card:{brand:'visa',last4:'4242',exp_month:12,exp_year:2035,...details},billing_details:{name:'Private provider detail excluded'}})
  const event=(id,created,object=card(),type='payment_method.automatically_updated')=>{
    events.set(id,{object:'event',id,type,created,livemode:false,data:{object}})
    return id
  }
  const fetch=async request=>{
    const url=new URL(request.url),path=url.pathname.slice(3),key=request.headers.get('authorization')
    calls.push({path,method:request.method})
    if(path.startsWith('/events/')){
      assert.equal(request.method,'GET');assert.equal(key,'Bearer synthetic-nectar-1')
      const value=events.get(path.split('/').at(-1));return value?Response.json(value):Response.json({},{status:404})
    }
    if(path.startsWith('/payment_methods/')&&methods.has(path.split('/').at(-1))){
      assert.equal(key,'Bearer synthetic-nectar-1');assert.equal(request.method,'GET')
      return Response.json(methods.get(path.split('/').at(-1)))
    }
    if(path==='/payment_methods'){
      const owner=url.searchParams.get('customer'),selected=base.customers.get(owner)
      const data=url.searchParams.get('type')==='card'?[methods.get(selected.method)??card(selected.method,owner)]:[]
      return Response.json({object:'list',has_more:false,data})
    }
    const response=await base.fetch(request)
    if(stolen&&path==='/payment_intents'&&request.method==='POST'){
      stolen=false
      const value=await response.json(),intent=value.error?.payment_intent
      assert.ok(intent,'Hard-decline fixture must start from a real failed provider attempt')
      intent.last_payment_error.decline_code='stolen_card'
      base.intents.get(intent.id).value.last_payment_error.decline_code='stolen_card'
      return Response.json(value,{status:response.status})
    }
    return response
  }
  return {...base,fetch,events,methods,calls,card,event,account,customer,method,
    stealNext(){stolen=true;base.refuseNext('card_declined')},
    posts:()=>base.calls.filter(call=>call.path==='/payment_intents'&&call.method==='POST').length}
}

let edge

export const harnessOptions=()=>{
  edge=lifecycleEdge()
  return {localTime:'2026-10-22T10:00:00Z',stripeFetch:edge.fetch,stripeSecret:'synthetic-nectar-1',stripeSecondarySecret:'synthetic-nectar-2'}
}

export async function lifecycleFlow(h,owner,{onState=async()=>{}}={}) {
  const api=(path,body,status)=>h.api(path,owner,body,status)
  const instant=Date.parse('2026-10-22T10:00:00Z')
  await h.advanceClock(new Date(instant).toISOString())
  await api('business.configure',{...await api('business'),timezone:'UTC'})
  const customer=(await api('customer.create',{external_id:'lifecycle-primary',name:'Lifecycle primary',billing_email:'lifecycle-primary@example.test'})).id
  const other=(await api('customer.create',{external_id:'lifecycle-other',name:'Lifecycle other',billing_email:'lifecycle-other@example.test'})).id
  const factor=await api('mfa.totp.start',{})
  await api('mfa.totp.confirm',{factor:factor.factor,code:totp(factor.secret,instant)})
  const binding=await api('collection.customer.bind',{customer,account_ref:edge.account,stripe_customer_ref:edge.customer,confirm:true})
  const foreign=await api('collection.customer.bind',{customer:other,account_ref:edge.account,stripe_customer_ref:'synthetic-nectar-native-customer-3',confirm:true})
  const consume=(event_ref,extra={},status=200)=>api('card.lifecycle.consume',{binding:binding.id,event_ref,confirm:true,...extra},status)
  const read=async id=>(await api(`customers/${id??customer}`)).billingRecord.cardLifecycle
  const first=edge.event('synthetic-lifecycle-event-new',instant/1000-10)
  edge.methods.set(edge.method,edge.card(edge.method,edge.customer,{last4:'1111',exp_month:6,exp_year:2038}))
  const ordinary=await h.signIn(h.vars.OWNER_EMAIL)
  const body={binding:binding.id,event_ref:first,confirm:true},reads=edge.calls.length
  await h.api('card.lifecycle.consume',ordinary,body,403)
  await h.api('card.lifecycle.consume',undefined,body,401)
  const agent={bearer:(await api('credential.issue',{name:'Lifecycle observer',scopes:['prepare']})).key}
  await h.api('card.lifecycle.consume',agent,body,403)
  assert.equal(edge.calls.length,reads,'Unauthorized event imports never contact Stripe')
  await consume(first,{confirm:false},400)
  await consume(first,{payload:{card:{last4:'9999'}}},400)
  await consume(first,{binding:foreign.id},409)
  assert.deepEqual(await read(),[])
  const mailCount=h.mails.length,posts=edge.posts()
  const updated=await consume(first)
  assert.equal(updated.replayed,false)
  assert.deepEqual(updated.card,{brand:'visa',last4:'1111',expMonth:6,expYear:2038})
  assert.equal(updated.usable,true);assert.equal(updated.debitAuthority,false)
  assert.deepEqual(await read(),[{...updated,replayed:undefined}].map(({replayed,...row})=>row))
  assert.deepEqual(await read(other),[],'The other customer cannot inherit this card observation')
  await onState({state:'updated',customer,other,binding:binding.id,method:updated})
  const beforeReplay=edge.calls.length,audit=await api('audit')
  assert.equal((await consume(first)).replayed,true)
  assert.equal(edge.calls.length,beforeReplay,'A consumed event is not fetched or applied again')
  assert.deepEqual(await api('audit'),audit,'Event replay adds no duplicate audit')
  const old=edge.event('synthetic-lifecycle-event-old',instant/1000-100,edge.card())
  assert.deepEqual((await consume(old)).card,updated.card,'An out-of-order snapshot fetches current card facts')
  assert.equal((await read())[0].sourceEventRef,first)
  const newer=edge.event('synthetic-lifecycle-event-concurrent',instant/1000-5)
  const concurrent=await Promise.all([consume(newer),consume(newer)])
  assert.deepEqual(concurrent.map(row=>row.replayed).sort(),[false,true])
  const wrongType=edge.event('synthetic-lifecycle-event-api-update',instant/1000,edge.card(),'payment_method.updated')
  await consume(wrongType,{},409)
  const wrongMode=edge.event('synthetic-lifecycle-event-live',instant/1000)
  edge.events.get(wrongMode).livemode=true
  await consume(wrongMode,{},409)
  const invalid=edge.event('synthetic-lifecycle-event-invalid',instant/1000)
  edge.methods.get(edge.method).card.last4='12345678'
  const validBefore=await read()
  await consume(invalid,{},409)
  assert.deepEqual(await read(),validBefore)
  edge.methods.get(edge.method).card.last4='1111'
  await api('customer.payment_methods.refresh',{customer})
  assert.deepEqual(await read(),validBefore,'Inventory refresh cannot replace independent lifecycle state')
  assert.equal(h.mails.length,mailCount,'Updater observations have no expiry-mail authority')
  assert.equal(edge.posts(),posts,'Updater observations have no debit authority')

  const invoice=async()=>{
    const charge=await api('charge.add',{customer,amount:'100',description:'Lifecycle renewal collection',effective_date:'2026-10-22',taxable:false})
    const draft=await api('invoice.manual',{customer,charges:[charge.charge],service_date:'2026-10-22'})
    await api('invoice.approve',{invoice:draft.id,acknowledge:true})
    await api('invoice.finalise',{invoice:draft.id,issue_date:'2026-10-22'})
    return draft.id
  }
  const failedInvoice=await invoice(),waitingInvoice=await invoice()
  const beforeDecline=await api('collection.prepare',{invoice:waitingInvoice}),prepared=await api('collection.prepare',{invoice:failedInvoice})
  edge.stealNext()
  const declined=await api('collection.confirm',prepared.instructions.confirm)
  assert.equal(declined.status,'declined')
  const blocked=(await read()).find(row=>row.methodRef===edge.method)
  assert.equal(blocked.usable,false);assert.equal(blocked.unusableReason,'stolen_card')
  const charged=edge.posts()
  await api('collection.prepare',{invoice:waitingInvoice},409)
  await api('collection.confirm',beforeDecline.instructions.confirm,409)
  assert.equal(edge.posts(),charged,'Another invoice cannot charge a globally prohibited method')
  const afterDecline=edge.event('synthetic-lifecycle-event-after-decline',instant/1000+1)
  assert.equal((await consume(afterDecline)).usable,false,'Network updates never remove a hard-decline prohibition')
  await api('customer.payment_methods.refresh',{customer})
  assert.equal((await read())[0].usable,false)
  await onState({state:'unusable',customer,other,binding:binding.id,method:(await read())[0]})
  const replacement='synthetic-lifecycle-replacement'
  edge.customers.get(edge.customer).method=replacement
  edge.methods.set(replacement,edge.card(replacement,edge.customer,{last4:'2222',exp_month:8,exp_year:2039}))
  const fresh=await api('collection.prepare',{invoice:waitingInvoice})
  const paid=await api('collection.confirm',fresh.instructions.confirm)
  assert.equal(paid.status,'collected');assert.equal(edge.posts(),charged+1)
  assert.equal((await api(`invoices/${waitingInvoice}`)).balanceCents,0)
  const retained=JSON.stringify([await read(),await api('audit')])
  assert.ok(!retained.includes('Private provider detail excluded')&&!retained.includes('billing_details'))
  await h.advanceClock(new Date(instant+16*60*1000).toISOString())
  const beforeStale=edge.calls.length
  await consume(first,{},403)
  assert.equal(edge.calls.length,beforeStale,'Even replay requires the current owner factor')
  console.log('PAY-005 updater current facts, event replay, order and isolation, no notices or debit, stolen-card global block and separately confirmed replacement payment passed')
}
