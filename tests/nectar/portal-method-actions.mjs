import assert from 'node:assert/strict'

// Extend only the Stripe boundary. All authority, claims and HTTP stay real.
export function portalMethodActionsEdge(edge) {
  const defaults=new Map(),calls=edge.calls
  let fault=null
  const fetch=async request=>{
    const path=new URL(request.url).pathname.slice(3),key=request.headers.get('idempotency-key')??''
    const record=[...edge.sessions.values()].find(row=>path===`/payment_methods/${row.method.id}`||path===`/payment_methods/${row.method.id}/detach`)
    if(request.method==='POST' && key.startsWith('nectar-portal-method-')) {
      const id=key.slice('nectar-portal-method-'.length)
      if(path.startsWith('/customers/')) {
        const customer=path.split('/').at(-1),body=new URLSearchParams(await request.text()),methodRef=body.get('invoice_settings[default_payment_method]')
        const selected=[...edge.sessions.values()].find(row=>row.method.id===methodRef)
        assert.ok(selected);assert.equal(selected.method.customer,customer)
        assert.deepEqual([...body.keys()],['invoice_settings[default_payment_method]'])
        defaults.set(customer,methodRef);calls.push({operation:'method-default',id,methodRef})
        if(fault==='lose-default'){fault=null;throw new Error('Synthetic lost selected default response')}
        return Response.json({object:'customer',id:customer,livemode:false,invoice_settings:{default_payment_method:methodRef}})
      }
      assert.ok(record && path.endsWith('/detach'))
      assert.equal(await request.text(),'')
      assert.ok(record.method.customer,'Detachment is sent exactly once')
      record.method.customer=null;calls.push({operation:'method-remove',id,methodRef:record.method.id})
      if(fault==='lose-remove'){fault=null;throw new Error('Synthetic lost method detachment response')}
      return Response.json(record.method)
    }
    if(request.method==='POST' && path.startsWith('/customers/') && key.startsWith('nectar-hosted-default-')) {
      const body=new URLSearchParams(await request.clone().text())
      defaults.set(path.split('/').at(-1),body.get('invoice_settings[default_payment_method]'))
    }
    const result=await edge.fetch(request)
    if(request.method==='GET' && path.startsWith('/customers/') && defaults.has(path.split('/').at(-1))) {
      const value=await result.json()
      return Response.json({...value,invoice_settings:{...value.invoice_settings,default_payment_method:defaults.get(value.id)}})
    }
    if(request.method==='GET' && record && ['method-customer','method-mode'].includes(fault)) {
      const value=await result.json()
      return Response.json({...value,...(fault==='method-customer'?{customer:'synthetic-nectar-foreign-customer'}:{livemode:true})})
    }
    return result
  }
  return {...edge,fetch,setActionFault:value=>{fault=value}}
}

/** Run after assertHostedSetups, before its populated customer's erasure. */
export async function assertPortalMethodActions(h,owner,{customer,other,binding,edge,finance,onState=async()=>{},executePrepare,executeAction}) {
  const api=(path,body,status)=>h.api(path,owner,body,status)
  const issue=customer=>api('portal.session.issue',{customer,origin:h.origin,audience:'hosted'})
  let session=await issue(customer)
  const foreign=await issue(other)
  const read=async capability=>{
    const response=await h.raw(`/portal/payment-methods/actions?session=${encodeURIComponent(capability.token)}`,{headers:{accept:'application/json'}})
    assert.equal(response.status,200)
    return response.json()
  }
  const post=async(action,operation='confirm',status=200,{capability=session,headers={},extra={}}={})=>{
    if(status===200&&capability===session&&executeAction)return executeAction({h,owner,customer,session,action,operation})
    const consentHash=status===401?'unavailable':(await read(capability)).find(row=>row.id===action)?.consentHash??'unavailable'
    const response=await h.raw(`/portal/payment-methods/action${operation==='reconcile'?'/reconcile':''}?session=${encodeURIComponent(capability.token)}`,
      {body:{action,confirm:true,consent_hash:consentHash,...extra},headers:{accept:'application/json',...headers}})
    const value=await response.json()
    assert.equal(response.status,status,`Method ${operation}: ${JSON.stringify(value)}`)
    return value
  }
  const prepare=(setup,operation,status)=>!status&&executePrepare?executePrepare({h,owner,customer,binding,setup,operation}):api('portal.method.prepare',{customer,binding,setup,operation,confirm:true},status)
  const writes=()=>edge.calls.filter(call=>['method-default','method-remove'].includes(call.operation)).length
  const sources=(await api(`customers/${customer}`)).billingRecord.hostedSetups
  const cards=sources.filter(row=>row.status==='complete'&&row.method==='card'&&!row.historical)
  const bank=sources.find(row=>row.status==='complete'&&row.method==='us_bank_account'&&!row.historical)
  assert.ok(cards.length>=2 && bank,'Hosted capture supplies existing completed methods')
  const card=cards[0],second=cards[1]
  const ordinary=await h.signIn(h.vars.OWNER_EMAIL)
  const input={customer,binding,setup:card.id,operation:'default',confirm:true}
  await h.api('portal.method.prepare',ordinary,input,403)
  await h.api('portal.method.prepare',finance,input,403)
  await api('portal.method.prepare',{...input,confirm:false},400)
  await api('portal.method.prepare',{...input,card_number:'4242424242424242'},400)
  await api('portal.method.prepare',{...input,customer:other},409)
  const beforeRecord=(await api(`customers/${customer}`)).billingRecord
  const selected=await prepare(card.id,'default')
  const state=async(state,action=selected)=>onState({h,owner,customer,session,setup:action.setup,action:action.id,operation:action.operation,state})
  await state('prepared')
  const beforeReads=writes(),audit=await api('audit')
  const actions=await read(session)
  assert.ok(actions.some(row=>row.id===selected.id&&row.status==='prepared'&&!row.historical))
  assert.deepEqual(await read(foreign),[],'Customer views expose only their own actions')
  assert.deepEqual(await api('audit'),audit,'Action GET never accepts or changes a default')
  assert.equal(writes(),beforeReads)
  await post(selected.id,'confirm',404,{capability:foreign})
  await post(selected.id,'confirm',400,{extra:{confirm:false}})
  await post(selected.id,'confirm',403,{headers:{origin:'https://synthetic-nectar-foreign.example'}})
  for(const fault of ['method-customer','method-mode']) {
    edge.setActionFault(fault)
    await post(selected.id,'confirm',409)
  }
  edge.setActionFault(null)
  assert.equal(writes(),beforeReads,'Foreign, mismatched and unconfirmed requests cause no provider writes')
  assert.equal((await post(selected.id)).status,'complete')
  await post(selected.id,'confirm',409)
  assert.equal(writes(),beforeReads+1,'A customer choice sends one default POST')
  await state('complete')
  await prepare(card.id,'remove',409)

  // Prepare a real exact-invoice authority on the chosen card. Selecting a new
  // default never rewrites it, and removal waits for its explicit revocation.
  const charge=await api('charge.add',{customer,amount:'4.25',description:'Synthetic method authority service',effective_date:'2026-10-22',taxable:false})
  const invoice=await api('invoice.manual',{customer,charges:[charge.charge],service_date:'2026-10-22'})
  const authority=await api('automatic.collection.prepare',{invoice:invoice.id,issue_date:'2026-10-22'})
  const bankDefault=await prepare(bank.id,'default')
  edge.setActionFault('lose-default')
  const lostBefore=writes()
  await post(bankDefault.id,'confirm',502)
  await state('uncertain',bankDefault)
  assert.equal((await read(session)).find(row=>row.id===bankDefault.id).status,'uncertain')
  await post(bankDefault.id,'confirm',409)
  await prepare(second.id,'default',409)
  assert.equal(writes(),lostBefore+1)
  assert.equal((await post(bankDefault.id,'reconcile')).status,'complete')
  assert.equal(writes(),lostBefore+1,'Lost default reconciliation performs GET only')
  await prepare(card.id,'remove',409)
  await api('automatic.collection.revoke',{request:authority.id})
  const remove=await prepare(card.id,'remove')
  edge.setActionFault('lose-remove')
  const removedBefore=writes()
  await post(remove.id,'confirm',502)
  await state('uncertain',remove)
  await post(remove.id,'confirm',409)
  assert.equal(writes(),removedBefore+1)
  assert.equal((await post(remove.id,'reconcile')).status,'complete')
  assert.equal(writes(),removedBefore+1,'Lost detach reconciliation performs GET only')
  await state('removed',remove)
  await prepare(card.id,'default',409)
  await prepare(bank.id,'remove',409)
  const removal=await prepare(second.id,'remove')
  const removalHash=(await read(session)).find(row=>row.id===removal.id).consentHash
  const competing=await Promise.all([1,2].map(()=>h.raw(`/portal/payment-methods/action?session=${encodeURIComponent(session.token)}`,
    {body:{action:removal.id,confirm:true,consent_hash:removalHash},headers:{accept:'application/json'}})))
  assert.deepEqual(competing.map(response=>response.status).sort(),[200,409])
  assert.equal(edge.calls.filter(call=>call.operation==='method-remove'&&call.id===removal.id).length,1,'Concurrent confirmations acquire one durable claim')

  const afterRecord=(await api(`customers/${customer}`)).billingRecord
  for(const family of ['processorPayments','paymentMethods','savedPaymentMethods','achPaymentEvidence','receipts','hostedSetups']) {
    assert.deepEqual(afterRecord[family],beforeRecord[family],'Method choices preserve historical payment and setup observations')
  }
  await h.assertStorageExcludes(['4242424242424242','routing_number','synthetic-nectar-810'])
  const languageWrites=writes(),displayed=(await api(`customers/${customer}`)).billingRecord.hostedSetups
  for(const language of ['en','es-US']) {
    const record=await api(`customers/${customer}`)
    await api('customer.update',{customer,revision:record.revision,name:record.name,billing_email:record.billing_email,language})
    session=await issue(customer)
    const translated=await prepare(bank.id,'default')
    const response=await h.raw(`/portal/payment-methods?session=${encodeURIComponent(session.token)}`)
    assert.equal(response.status,200)
    const html=await response.text()
    assert.match(html,new RegExp(`lang="${language}"`));assert.ok(html.includes('6789'))
    assert.ok(!html.includes('methods.confirm.default')&&!html.includes('methods.status.prepared'))
    assert.deepEqual((await api(`customers/${customer}`)).billingRecord.hostedSetups,displayed,'Both languages preserve identical payment method figures')
    await state(`locale-${language}`,translated)
  }
  assert.equal(writes(),languageWrites,'Translated reads and owner preparations never change the processor')
  const pending=await prepare(bank.id,'default')
  const record=await api(`customers/${customer}`)
  await api('customer.update',{customer,revision:record.revision,name:record.name,billing_email:record.billing_email,language:record.language==='en'?'es-US':'en'})
  const staleWrites=writes()
  await post(pending.id,'confirm',404)
  assert.equal(writes(),staleWrites,'A changed customer revision cannot claim the old preparation')
  session=await issue(customer)
  const revoked=await prepare(bank.id,'default')
  await api('portal.session.revoke',{session:session.id})
  await post(revoked.id,'confirm',401)
  await state('refused',revoked)
  assert.equal(writes(),staleWrites,'Revoked customer access cannot send a provider write')
}
