// Held-key qualification of posted sandbox deposits through the native public doors.
// The temporary Plaid Item is removed; no credential or source body is printed.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { runIsolated } from './isolated.mjs'
import { remittanceFile } from './remittance-files.mjs'
import { totp } from './mfa.mjs'
import { file } from './harness.mjs'
import { bankQueueScreens } from './remittance-plaid.mjs'
import { csvRows } from './financial-reports.mjs'

const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()
const clientId=process.env.PLAID_CLIENT_ID,secret=process.env.PLAID_SECRET
assert.ok(clientId&&secret,'Named Plaid sandbox credentials are required')
const day=new Date().toISOString().slice(0,10),instant=`${day}T12:00:00Z`,tag=`synthetic-nectar-${randomUUID()}`
const requests=[];let accessToken,removed=false
async function request(path,fields={}) {
 let response,value
 try {
  response=await fetch(`https://sandbox.plaid.com${path}`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{'content-type':'application/json','Plaid-Version':'2020-09-14'},body:JSON.stringify({client_id:clientId,secret,...fields})})
  value=await response.json()
 }catch{throw new Error('Plaid sandbox transport unavailable')}
 requests.push({path,status:response.status,requestId:value?.request_id??null})
 if(!response.ok){const code=typeof value?.error_code==='string'&&/^[A-Z_]+$/.test(value.error_code)?value.error_code:'provider_failure';throw new Error(`Plaid sandbox HTTP ${response.status} ${code}`)}
 return value
}
try {
 const created=await request('/sandbox/public_token/create',{institution_id:'ins_109508',initial_products:['transactions']})
 const exchanged=await request('/item/public_token/exchange',{public_token:created.public_token});accessToken=exchanged.access_token
 const connected=await request('/accounts/get',{access_token:accessToken})
 const account=connected.accounts.find(row=>row.type==='depository'&&row.subtype==='checking'&&row.balances?.iso_currency_code==='USD')?.account_id
 assert.ok(account,'A USD depository account is required')
 const deposits=[['wire',600.06],['ach',125],['short',35],['unknown',7]]
 await request('/sandbox/transactions/create',{access_token:accessToken,transactions:deposits.map(([kind,amount])=>({account_id:account,amount:-amount,iso_currency_code:'USD',date_transacted:day,date_posted:day,description:`${tag}-${kind}`}))})
 let posted=[]
 for(const wait of [0,2000,5000,10000,15000]){
  if(wait)await delay(wait)
  const observed=await request('/transactions/get',{access_token:accessToken,start_date:day,end_date:day,options:{account_ids:[account],count:500,offset:0}})
  posted=observed.transactions.filter(row=>deposits.some(([kind])=>row.name===`${tag}-${kind}`))
  if(posted.length===4)break
 }
 assert.equal(posted.length,4,'The actual sandbox must expose all four posted deposits')
 const ids=Object.fromEntries(deposits.map(([kind])=>[kind,posted.find(row=>row.name===`${tag}-${kind}`).transaction_id]))
 async function forward(incoming) {
  const url=new URL(incoming.url),body=await incoming.json()
  assert.equal(url.origin,'https://sandbox.plaid.com');assert.ok(['/accounts/get','/transactions/get'].includes(url.pathname),'The Worker can only read the sandbox')
  assert.ok(body.client_id===clientId&&body.secret===secret&&body.access_token===accessToken,'The Worker uses only this qualification Item')
  return Response.json(await request(url.pathname,body))
 }
 await runIsolated('remittance-plaid-sandbox','postedBankReceipts',async()=>({
  harnessOptions:()=>({assets:true,localTime:instant,plaidFetch:forward,settings:{PLAID_CLIENT_ID:clientId,PLAID_SECRET:secret,PLAID_ACCESS_TOKEN:accessToken}}),
  async postedBankReceipts(h,owner) {
   const api=(path,body,status)=>h.api(path,owner,body,status),factor=await api('mfa.totp.start',{})
   await api('mfa.totp.confirm',{factor:factor.factor,code:totp(factor.secret,Date.parse(instant))})
   const customer=(await api('customer.create',{external_id:tag,name:'Synthetic sandbox customer',billing_email:[tag,'example.test'].join('@')})).id
   const invoice=async amount=>{
    const charge=(await api('charge.add',{customer,amount,description:'Sandbox bank service',effective_date:day,taxable:false})).charge
    const id=(await api('invoice.manual',{customer,charges:[charge],service_date:day})).id
    await api('invoice.approve',{invoice:id,acknowledge:true});await api('invoice.finalise',{invoice:id,issue_date:day})
    return api(`invoices/${id}`)
   }
   const invoices=[];for(const amount of ['100.01','200.02','300.03','125.00','90.00','50.00'])invoices.push(await invoice(amount))
   const rows=(kind,amount,lines=[],who=tag)=>(lines.length?lines:[['','']]).map(([number,allocated])=>[ids[kind],day,'USD',amount,who,number,allocated])
   const advice=remittanceFile([...rows('wire','600.06',invoices.slice(0,3).map((row,i)=>[row.number,['100.01','200.02','300.03'][i]])),...rows('ach','125.00',[[invoices[3].number,'125.00']]),...rows('short','35.00',[[invoices[4].number,'35.00']]),...rows('unknown','7.00',[],'')])
   const preview=await api('bank.remittance.preview',{account,file:advice})
   assert.equal(preview.receipts.filter(row=>row.autoApply).length,3);assert.equal((await api('payments')).length,0)
   const confirmed=await api('bank.remittance.confirm',{account,file:advice,fingerprint:preview.fingerprint,confirm:true})
   assert.equal(confirmed.duplicate,false);assert.equal((await api('payments')).length,3)
   for(const row of invoices.slice(0,4))assert.equal((await api(`invoices/${row.id}`)).balanceCents,0)
   assert.equal((await api(`invoices/${invoices[4].id}`)).balanceCents,5500)
   await bankQueueScreens(h,owner)
   const unknown=preview.receipts.find(row=>row.source===ids.unknown).id
   const queued=(await api('cash-application-queue')).find(row=>row.id===unknown)
   assert.equal(queued.source,'plaid_sandbox');assert.equal(queued.unallocatedCents,700);assert.equal(queued.customer,null)
   const identified=await api('remittance.preview',{receipt:unknown,customer})
   await api('remittance.confirm',{receipt:unknown,customer,fingerprint:identified.fingerprint,confirm:true})
   const allocation=await api('remittance.allocate.preview',{receipt:unknown,invoice:invoices[5].id,amount:'7.00'})
   await api('remittance.allocate',{receipt:unknown,invoice:invoices[5].id,amount:'7.00',fingerprint:allocation.fingerprint,confirm:true})
   const before=await api('payments')
   assert.equal((await api('bank.remittance.confirm',{account,file:advice,fingerprint:preview.fingerprint,confirm:true})).duplicate,true)
   assert.deepEqual(await api('payments'),before,'A repeated real provider capture cannot recreate received funds')
   const ledger=(await api(`customers/${customer}`)).ledger
   assert.deepEqual([ledger.invoicedCents,ledger.paidCents,ledger.balanceCents],[86506,76706,9800])
   assert.equal((await api(`reports/collections?period=${day.slice(0,7)}&customer=${customer}`)).totalCents,76706)
   const csv=csvRows(await(await h.raw(`/app/exports/reports/collections.csv?period=${day.slice(0,7)}&customer=${customer}`,{cookie:owner})).text())
   assert.equal(csv.find(row=>row.source==='TOTAL').amount,'767.06')
   const erasure=await api('erasure.request',{customer})
   await api('erasure.verify',{request:erasure.id,reason:'Independent synthetic sandbox identity',evidence:file('synthetic-nectar-bank-proof.txt','Synthetic identity verification')})
   await api('erasure.approve',{request:erasure.id,confirm:true})
   await api('bank.remittance.preview',{account,file:advice},409)
  },
 }))
 await request('/item/remove',{access_token:accessToken});removed=true
 console.log(JSON.stringify({head,provider:'plaid_sandbox',postedDeposits:4,cashCents:76706,remainingInvoiceCents:9800,sourceReplayRefusedAfterErasure:true,itemRemoved:removed,requests}))
} catch(error) {
 // Assertion messages contain only product figures or typed refusals; never print provider bodies.
 console.error(error instanceof assert.AssertionError?`Sandbox assertion: ${error.message}`:error.message)
 process.exitCode=1
} finally {
 if(accessToken&&!removed){try{await request('/item/remove',{access_token:accessToken});console.log('Temporary Plaid sandbox Item removed')}catch(error){console.error(error.message);process.exitCode=1}}
}
