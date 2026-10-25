// Extends the native Stripe network edge; application code and storage stay real.
import assert from 'node:assert/strict'

export function customerPaymentMethodsEdge(baseFetch) {
  const calls = [], customer = 'synthetic-nectar-native-customer-1'
  let fault = null
  const fetch = async request => {
    const url = new URL(request.url)
    if (url.pathname !== '/v1/payment_methods') return baseFetch(request)
    assert.equal(request.method, 'GET', 'Inventory never writes to Stripe')
    assert.equal(request.headers.get('authorization'), 'Bearer synthetic-nectar-1')
    assert.equal(url.searchParams.get('customer'), customer)
    const type = url.searchParams.get('type'), cursor = url.searchParams.get('starting_after')
    calls.push({ method: request.method, type, cursor })
    assert.ok(['card', 'us_bank_account'].includes(type))
    const id = type === 'card' ? `synthetic-nectar-native-card-${cursor ? '5' : '1'}` : 'synthetic-nectar-native-bank-1'
    const method = { object: 'payment_method', id, customer, livemode: false, type,
      ...(type === 'card' ? { card: { brand: 'visa', last4: cursor ? '1111' : '4242', exp_month: 12, exp_year: 2035 } }
        : { us_bank_account: { bank_name: 'Synthetic Nectar Bank', last4: '6789', account_type: 'checking', routing_number: '110000000' } }),
      billing_details: { name: 'Synthetic private billing name', email: 'synthetic-nectar-99@example.test' } }
    if (fault === 'customer') method.customer = 'synthetic-nectar-native-customer-99'
    if (fault === 'livemode') method.livemode = true
    if (fault === 'repeat' && type === 'card' && cursor) method.id = cursor
    if (fault === 'empty') return Response.json({ object: 'list', has_more: true, data: [] })
    return Response.json({ object: 'list', has_more: type === 'card' && !cursor, data: [method] })
  }
  return { fetch, calls, setFault: value => { fault = value } }
}

/** Call after native customer binding and fresh owner factor are established. */
export async function assertCustomerPaymentMethods(h, owner, { customer, other, finance, edge,refresh,
  read = async cookie => (await h.api(`customers/${customer}`, cookie)).billingRecord.savedPaymentMethods }) {
  const before = edge.calls.length
  const refreshed = refresh?await refresh({h,owner,customer}):await h.api('customer.payment_methods.refresh', owner, { customer })
  assert.equal(refreshed.length, 1)
  const [snapshot] = refreshed
  assert.equal(snapshot.customer, customer)
  assert.equal(snapshot.historical, true)
  assert.equal(snapshot.debitAuthority, false)
  assert.ok(Number.isSafeInteger(snapshot.fetchedAt))
  assert.deepEqual(snapshot.methods.map(method => method.type).sort(), ['card', 'card', 'us_bank_account'])
  assert.ok(snapshot.methods.some(method => method.type === 'us_bank_account' && method.last4 === '6789'))
  assert.ok(edge.calls.slice(before).some(call => call.cursor), 'All provider pages are read')
  assert.ok(!JSON.stringify(snapshot).includes('routing_number') && !JSON.stringify(snapshot).includes('billing_details'))
  assert.deepEqual(await read(owner), refreshed)
  if (finance) {
    assert.deepEqual(await read(finance), refreshed)
    await h.api('customer.payment_methods.refresh', finance, { customer }, 403)
  }
  if (other) assert.deepEqual((await h.api(`customers/${other}`, owner)).billingRecord.savedPaymentMethods, [])
  for (const fault of ['customer', 'livemode', 'repeat', 'empty']) {
    edge.setFault(fault)
    await h.api('customer.payment_methods.refresh', owner, { customer }, 409)
    assert.deepEqual(await read(owner), refreshed, 'An invalid or incomplete provider read preserves the previous snapshot')
  }
  edge.setFault(null)
  return refreshed
}

// Processor fixtures only: every transition under test still uses real HTTP and D1.
export function hostedSetupEdge(baseFetch) {
  const sessions = new Map(), calls = [], defaults = new Map()
  const customers=new Set(['synthetic-nectar-native-customer-1','synthetic-nectar-native-customer-3'])
  let fault = null
  const fetch = async request => {
    const path = new URL(request.url).pathname.slice(3)
    const record = [...sessions.values()].find(row => [row.session.id,row.setup.id,row.method.id,row.mandate.id].some(id => path.endsWith(`/${id}`)))
    if (path === '/checkout/sessions' && request.method === 'POST') {
      const body = new URLSearchParams(await request.text()), id = body.get('metadata[nectar_setup_id]'), method = body.get('payment_method_types[0]'), customer=body.get('customer')
      assert.equal(body.get('setup_intent_data[metadata][nectar_setup_id]'), id)
      assert.equal(body.get('mode'), 'setup'); assert.ok(customers.has(customer))
      assert.ok(['card','us_bank_account'].includes(method))
      assert.equal(request.headers.get('idempotency-key'), `nectar-hosted-setup-${id}`)
      if (method === 'us_bank_account') {
        assert.equal(body.get('payment_method_options[us_bank_account][financial_connections][permissions][0]'), 'payment_method')
        assert.equal(body.get('payment_method_options[us_bank_account][verification_method]'), 'automatic')
      }
      calls.push({ operation:'create', id, locale:body.get('locale') })
      const sessionRef=`cs_setup_${sessions.size+1}`, setupRef=`seti_setup_${sessions.size+1}`, methodRef=`pm_setup_${sessions.size+1}`, mandateRef=`mandate_setup_${sessions.size+1}`
      const metadata={nectar_setup_id:id}, common={customer,livemode:false}
      const row={
        session:{object:'checkout.session',id:sessionRef,...common,mode:'setup',status:'open',metadata,payment_method_types:[method],setup_intent:setupRef,url:`https://checkout.stripe.com/c/pay/${sessionRef}`},
        setup:{object:'setup_intent',id:setupRef,...common,status:'succeeded',metadata,payment_method_types:[method],payment_method:methodRef,mandate:method==='us_bank_account'?mandateRef:null,client_secret:'synthetic-nectar-810'},
        method:{object:'payment_method',id:methodRef,...common,type:method,...(method==='card'?{card:{brand:'visa',last4:'4242',exp_month:12,exp_year:2035}}:{us_bank_account:{bank_name:'Synthetic Nectar Bank',last4:'6789',account_type:'checking',routing_number:'110000000'}})},
        mandate:{object:'mandate',id:mandateRef,livemode:false,type:'multi_use',status:'active',payment_method:methodRef,payment_method_details:{type:'us_bank_account'},customer_acceptance:{type:'online',accepted_at:1792663200,online:{ip_address:'127.0.0.1',user_agent:'Synthetic processor browser'}}},
      }
      sessions.set(id,row)
      if(fault==='lose-create'){fault=null;throw new Error('Synthetic lost checkout response')}
      return Response.json(row.session)
    }
    if(record && request.method==='GET') {
      calls.push({operation:'read',path})
      if(path.startsWith('/checkout/sessions/'))return Response.json({...record.session,...(fault==='session-id'?{id:'cs_wrong'}:{})})
      if(path.startsWith('/setup_intents/'))return Response.json(record.setup)
      if(path.startsWith('/payment_methods/'))return Response.json(record.method)
      if(path.startsWith('/mandates/'))return Response.json({...record.mandate,...(fault==='mandate'?{payment_method:'pm_other_customer'}:{})})
    }
    const customer=path.startsWith('/customers/')?path.split('/').at(-1):null
    if(customers.has(customer) && request.method==='POST') {
      const body=new URLSearchParams(await request.text())
      const defaultMethod=body.get('invoice_settings[default_payment_method]')
      const row=[...sessions.values()].find(value=>value.method.id===defaultMethod)
      assert.ok(row);assert.equal(row.method.customer,customer)
      defaults.set(customer,defaultMethod)
      assert.equal(request.headers.get('idempotency-key'),`nectar-hosted-default-${row.session.metadata.nectar_setup_id}`)
      calls.push({operation:'default',methodRef:defaultMethod})
      if(fault==='lose-default'){fault=null;throw new Error('Synthetic lost default response')}
      return Response.json({object:'customer',id:customer,livemode:false,invoice_settings:{default_payment_method:defaultMethod}})
    }
    const response=await baseFetch(request)
    if(defaults.has(customer) && request.method==='GET') {
      const value=await response.json()
      return Response.json({...value,invoice_settings:{...value.invoice_settings,default_payment_method:defaults.get(customer)}})
    }
    return response
  }
  return {fetch,calls,sessions,setFault:value=>{fault=value},complete:id=>{sessions.get(id).session.status='complete'}}
}

export async function assertHostedSetups(h, owner, { customer, other, binding, finance, edge, onState=async()=>{}, executeStart, executeFinish, executePrepare }) {
  await h.api('portal.configure',owner,{hosts:[h.origin],parents:[]})
  const issue=customer=>h.api('portal.session.issue',owner,{customer,origin:h.origin,audience:'hosted'})
  const otherSession=await issue(other)
  const post=async(session,operation,setup,status=200,extra={})=>{
    const response=await h.raw(`/portal/payment-methods.${operation}?session=${encodeURIComponent(session.token)}`,{body:{setup,confirm:true,...extra},headers:{accept:'application/json'}})
    const value=await response.json()
    assert.equal(response.status,status,`Hosted ${operation}: ${JSON.stringify(value)}`)
    return value
  }
  const prepare=method=>executePrepare?executePrepare({h,owner,customer,binding,method}):h.api('checkout.setup.prepare',owner,{customer,binding,method,confirm:true})
  const writes=operation=>edge.calls.filter(call=>call.operation===operation).length
  const updateLanguage=async language=>{
    const current=await h.api(`customers/${customer}`,owner)
    await h.api('customer.update',owner,{customer,revision:current.revision,name:current.name,billing_email:current.billing_email,language})
  }
  await h.api('checkout.setup.prepare',finance,{customer,binding,method:'card',confirm:true},403)
  await h.api('checkout.setup.prepare',owner,{customer,binding,method:'card',confirm:true,card_number:'4242424242424242'},400)
  for(const [method,language,locale] of [['card','en','en'],['us_bank_account','es-US','es']]) {
    await updateLanguage(language)
    const session=await issue(customer), setup=await prepare(method)
    const state=async state=>onState({h,owner,session,customer,setup:setup.id,state,method})
    const preparedPage=await h.raw(`/portal/payment-methods?session=${encodeURIComponent(session.token)}`,{headers:{accept:'text/html'}})
    assert.equal(preparedPage.status,200)
    assert.match(await preparedPage.text(),new RegExp(`lang="${language}"`))
    await state('prepared')
    const creates=writes('create')
    await post(otherSession,'start',setup.id,404)
    await post(session,'start',setup.id,400,{account_number:'123456789012'})
    assert.equal(writes('create'),creates,'Refused input never contacts hosted capture')
    const opened=executeStart?await executeStart({h,owner,session,setup:setup.id,method,post:()=>post(session,'start',setup.id)}):await post(session,'start',setup.id)
    assert.equal(opened.status,'open');assert.equal(new URL(opened.url).hostname,'checkout.stripe.com')
    const provider=edge.sessions.get(setup.id)
    assert.equal(opened.url,provider.session.url)
    assert.equal(edge.calls.filter(call=>call.operation==='create').at(-1).locale,locale)
    await state('open')
    const defaults=writes('default')
    await post(session,'finish',setup.id,409)
    assert.equal(writes('default'),defaults,'Pending processor completion never changes default')
    edge.complete(setup.id)
    edge.setFault(method==='card'?'session-id':'mandate')
    await post(session,'finish',setup.id,409)
    assert.equal(writes('default'),defaults,'Mismatched processor custody never changes default')
    edge.setFault(null)
    await post(otherSession,'finish',setup.id,404)
    const finished=executeFinish?await executeFinish({h,owner,session,setup:setup.id,method,post:()=>post(session,'finish',setup.id)}):await post(session,'finish',setup.id)
    assert.equal(finished.status,'complete')
    assert.equal((await post(session,'finish',setup.id)).status,'complete')
    assert.equal(writes('default'),defaults+1,'Repeated completion updates the customer default once')
    await state('complete')
    const record=await h.api(`customers/${customer}`,owner)
    const saved=record.billingRecord.hostedSetups.find(row=>row.id===setup.id)
    assert.equal(saved.status,'complete')
    const safe=JSON.stringify(saved)
    assert.ok(safe.includes(provider.method.id) && safe.includes(method==='card'?'4242':'6789'))
    if(method==='us_bank_account') {
      assert.equal(saved.paymentMethod.mandateRef,provider.mandate.id,'Captured ACH retains the verified mandate reference')
      assert.equal(saved.paymentMethod.mandateText,null,'Unavailable processor authorization text is never fabricated')
    }
    for(const privateValue of ['synthetic-nectar-810','110000000','routing_number','ip_address','user_agent','4242424242424242','123456789012'])assert.ok(!safe.includes(privateValue),'Customer projection contains no financial input or private acceptance payload')
  }
  await h.assertStorageExcludes(['4242424242424242','123456789012','synthetic-nectar-810'])
  const exported=await h.page('/app/exports/customers.csv',owner)
  for(const value of ['4242424242424242','123456789012','synthetic-nectar-810'])assert.ok(!exported.includes(value),'Customer export excludes financial input and provider secrets')
  const currentMethods=(await h.api(`customers/${customer}`,owner)).billingRecord.hostedSetups
  for(const language of ['en','es-US']){
    await updateLanguage(language)
    const translated=await h.raw(`/portal/payment-methods?session=${encodeURIComponent((await issue(customer)).token)}`)
    const html=await translated.text();assert.equal(translated.status,200)
    assert.match(html,new RegExp(`lang="${language}"`));assert.ok(html.includes('4242')&&html.includes('6789'))
    assert.deepEqual((await h.api(`customers/${customer}`,owner)).billingRecord.hostedSetups,currentMethods,'Translation preserves the identical capture facts')
  }
  await updateLanguage('en')
  const session=await issue(customer)
  const isolatedCustomer=(await h.api('customer.create',owner,{external_id:'synthetic-nectar-809',name:'Synthetic hosted uncertainty',billing_email:'synthetic-nectar-809@example.test'})).id
  const isolatedBinding=await h.api('collection.customer.bind',owner,{customer:isolatedCustomer,account_ref:'synthetic-nectar-native-account-1',stripe_customer_ref:'synthetic-nectar-native-customer-3',confirm:true})
  const isolatedSession=await issue(isolatedCustomer)
  for(const [operation,fault,write,target,holdBinding,capability] of [
    ['finish','lose-default','default',customer,binding,session],
    ['start','lose-create','create',isolatedCustomer,isolatedBinding.id,isolatedSession],
  ]) {
    const setup=await h.api('checkout.setup.prepare',owner,{customer:target,binding:holdBinding,method:'card',confirm:true})
    if(operation==='finish'){await post(capability,'start',setup.id);edge.complete(setup.id)}
    const before=writes(write)
    edge.setFault(fault)
    await post(capability,operation,setup.id,502)
    await post(capability,operation,setup.id,409)
    assert.equal(writes(write),before+1,'An uncertain provider response never repeats its POST')
    await h.api('checkout.setup.prepare',owner,{customer:target,binding:holdBinding,method:'card',confirm:true},409)
    assert.equal(writes(write),before+1,'A replacement preparation cannot bypass uncertain provider custody')
  }
  assert.deepEqual((await h.api(`customers/${other}`,owner)).billingRecord.hostedSetups,[])
}
