// Actual Plaid sandbox capture. Temporary Item credentials remain in memory.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { processorSetup } from './processor-events.mjs'
import { plaidRemittancesFlow } from './plaid-remittances.mjs'
const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()
let access,h,phase='setup'
const request=async(path,body={})=>{
 const response=await fetch('https://sandbox.plaid.com'+path,{method:'POST',signal:AbortSignal.timeout(30000),
  headers:{'content-type':'application/json'},body:JSON.stringify({client_id:process.env.PLAID_CLIENT_ID,secret:process.env.PLAID_SANDBOX_SECRET,...body})})
 const result=await response.json()
 if(!response.ok)throw Object.assign(Error('Plaid '+response.status+' '+String(result.error_code??'unknown')),{code:result.error_code})
 return result
}
try{
 const setup=await processorSetup(undefined,{localTime:'2026-10-28T12:00:00Z',plaidFetch:async incoming=>{
   try{
    const url=new URL(incoming.url)
    assert.equal(url.origin,'https://sandbox.plaid.com')
    const response=await fetch(url,{method:'POST',signal:AbortSignal.timeout(30000),headers:{'content-type':'application/json'},body:await incoming.text()})
    if(!response.ok){const body=await response.clone().json();console.log(JSON.stringify({transportStatus:response.status,code:body.error_code}))}
    return response
   }catch(error){console.log(JSON.stringify({transportError:error.code??error.name}));throw error}
  },settings:{}})
 h=setup.h
 await plaidRemittancesFlow(h,setup.owner,{createDeposits:async deposits=>{
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
 console.log(JSON.stringify({head,status:'passed',provider:'Plaid sandbox',outcomes:['three-invoice wire','ACH advice','short balance','unidentified queue','replay','authority refusals','erasure refusal']}))
}catch(error){
 console.log(JSON.stringify({head,status:'failed',phase,error:String(error.message).replace(/(?:access|public|sandbox)-[A-Za-z0-9_-]+/g,'REDACTED')}))
 process.exitCode=1
}finally{
 if(h)await h.close()
 if(access)try{await request('/item/remove',{access_token:access});console.log('Plaid temporary Item removed')}catch{console.log('Plaid Item cleanup failed');process.exitCode=1}
}
