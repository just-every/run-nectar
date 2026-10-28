// Actual Plaid sandbox capture. Temporary Item credentials remain in memory.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { stripeSandbox } from './stripe-sandbox-client.mjs'
import { processorSetup } from './processor-events.mjs'
import { totp } from './mfa.mjs'
import { plaidRemittancesFlow } from './plaid-remittances.mjs'
const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()
let access,h,phase='setup'
const stripe=process.env.STRIPE_SECRET_KEY?stripeSandbox(process.env.STRIPE_SECRET_KEY):null
const request=async(path,body={})=>{
 const response=await fetch('https://sandbox.plaid.com'+path,{method:'POST',signal:AbortSignal.timeout(30000),
  headers:{'content-type':['application','json'].join('/')},body:JSON.stringify({client_id:process.env.PLAID_CLIENT_ID,secret:process.env.PLAID_SANDBOX_SECRET,...body})})
 const result=await response.json()
 if(!response.ok)throw Object.assign(Error('Plaid '+response.status+' '+String(result.error_code??'unknown')),{code:result.error_code})
 return result
}
try{
 const setup=await processorSetup(undefined,{localTime:'2026-10-28T12:00:00Z',...(stripe?{stripeSecret:process.env.STRIPE_SECRET_KEY,stripeFetch:request=>stripe.forward(request)}:{}),plaidFetch:async incoming=>{
   try{
    const url=new URL(incoming.url)
    assert.equal(url.origin,'https://sandbox.plaid.com')
    const response=await fetch(url,{method:'POST',signal:AbortSignal.timeout(30000),headers:{'content-type':['application','json'].join('/')},body:await incoming.text()})
    if(!response.ok){const body=await response.clone().json();console.log(JSON.stringify({transportStatus:response.status,code:body.error_code}))}
    return response
   }catch(error){console.log(JSON.stringify({transportError:error.code??error.name}));throw error}
  },settings:{}})
 h=setup.h
 const native=await plaidRemittancesFlow(h,setup.owner,{createDeposits:async deposits=>{
  phase='create-item'
  const custom={override_accounts:[{type:'depository',subtype:'checking',currency:'USD',starting_balance:10000,
   transactions:deposits.map(row=>({amount:row.amount,date_posted:row.date,date_transacted:row.date,description:row.name,currency:'USD'}))}]}
  const created=await request('/sandbox/public_token/create',{institution_id:'ins_109508',initial_products:['transactions'],options:{override_username:'user_custom',override_password:JSON.stringify(custom)}})
  access=(await request('/item/public_token/exchange',{public_token:created.public_token})).access_token
  const accounts=await request('/accounts/get',{access_token:access});assert.equal(accounts.accounts.length,1)
  const account=accounts.accounts[0].account_id
  Object.assign(h.vars,{PLAID_CLIENT_ID:process.env.PLAID_CLIENT_ID,PLAID_SANDBOX_SECRET:process.env.PLAID_SANDBOX_SECRET,PLAID_ACCESS_TOKEN:access,PLAID_ACCOUNT_ID:account})
  await h.advanceClock('2026-10-28T12:00:00Z')
  let actual
  for(let attempt=0;attempt<12;attempt++){
   let history
   try{history=await request('/transactions/get',{access_token:access,start_date:'2026-10-15',end_date:'2026-10-15',options:{account_ids:[account],count:100,offset:0}})}catch(error){if(error.code!=='PRODUCT_NOT_READY')throw error;await delay(2000);continue}
   if(history.transactions.length===4){actual=deposits.map(row=>history.transactions.find(found=>found.name===row.name&&found.amount===row.amount));if(actual.every(Boolean))break}
   await delay(2000)
  }
  assert.ok(actual?.every(Boolean),'The real Plaid capture contains all four exact seeded deposits')
  phase='public-capture'
  return actual
 }})
 if(stripe){
  phase='bank-payout'
  const account=await stripe.request('GET','/v1/account')
  const payouts=(await stripe.list('/v1/payouts')).data.filter(row=>row.automatic===true&&row.status==='paid'&&row.reconciliation_status==='completed'&&row.currency==='usd')
  assert.ok(payouts.length,'A real automatic payout with completed reconciliation is required')
  const payout=payouts[0],events=(await stripe.list('/v1/events',{type:'payout.paid'})).data
  const event=events.find(row=>row.data.object.id===payout.id)
  assert.ok(event,'The actual payout has its processor event')
  await h.api('processor.event.consume',setup.owner,{account_ref:account.id,event_ref:event.id})
  await request('/item/remove',{access_token:access});access=null
  const day=new Date().toISOString().slice(0,10)
  const custom={override_accounts:[{type:'depository',subtype:'checking',currency:'USD',starting_balance:10000,transactions:[{amount:-payout.amount/100,date_posted:day,date_transacted:day,description:'Stripe '+payout.id,currency:'USD'}]}]}
  const created=await request('/sandbox/public_token/create',{institution_id:'ins_109508',initial_products:['transactions'],options:{override_username:'user_custom',override_password:JSON.stringify(custom)}})
  access=(await request('/item/public_token/exchange',{public_token:created.public_token})).access_token
  const bankAccounts=await request('/accounts/get',{access_token:access}),bankAccount=bankAccounts.accounts[0].account_id
  Object.assign(h.vars,{PLAID_ACCESS_TOKEN:access,PLAID_ACCOUNT_ID:bankAccount})
  const now=Date.now();await h.advanceClock(new Date(now).toISOString())
  await h.api('mfa.verify',setup.owner,{code:totp(native.factorSecret,now)})
  for(let attempt=0;attempt<12;attempt++){
   try{const history=await request('/transactions/get',{access_token:access,start_date:day,end_date:day});if(history.transactions.length===1)break}catch(error){if(error.code!=='PRODUCT_NOT_READY')throw error}
   await delay(2000)
  }
  const before=await h.api('payments',setup.owner)
  const capture={from:day,through:day,confirm:true}
  const matched=await h.api('plaid.capture',setup.owner,capture)
  assert.equal(matched.payouts.length,1);assert.deepEqual(matched.receipts,[])
  await h.api('plaid.capture',setup.owner,capture)
  assert.deepEqual(await h.api('payments',setup.owner),before,'A real payout bank deposit never duplicates its gross captured receipts')
  const observed=await h.api('processor-events',setup.owner)
  const match=observed.bankMatches.find(row=>row.payout_ref===payout.id)
  assert.equal(match.amount_cents,payout.amount)
  console.log(JSON.stringify({head,status:'passed',kind:'actual-payout-bank-match',payout:payout.id,event:event.id,netCents:payout.amount,members:observed.transactions.filter(row=>row.payout_ref===payout.id&&row.type!=='payout').length}))
 }
 console.log(JSON.stringify({head,status:'passed',provider:'Plaid sandbox',outcomes:['three-invoice wire','ACH advice','short balance','unidentified queue','replay','authority refusals','erasure refusal']}))
}catch(error){
 console.log(JSON.stringify({head,status:'failed',phase,error:String(error.message).replace(/(?:access|public|sandbox)-[A-Za-z0-9_-]+/g,'REDACTED')}))
 process.exitCode=1
}finally{
 if(h)await h.close()
 if(access)try{await request('/item/remove',{access_token:access});console.log('Plaid temporary Item removed')}catch{console.log('Plaid Item cleanup failed');process.exitCode=1}
}
