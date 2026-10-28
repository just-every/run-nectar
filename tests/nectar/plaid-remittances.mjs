// One money journey through the real Worker and D1; only Plaid is at the edge.
import assert from 'node:assert/strict'
import { remittanceFixtures, remittanceFile } from './remittance-files.mjs'
import { processorEdge } from './processor-edge.mjs'
import { file } from './harness.mjs'
import { totp } from './mfa.mjs'
export const bankAccount='synthetic-nectar-bank-account'
const settings={PLAID_CLIENT_ID:'synthetic-nectar-client',PLAID_SANDBOX_SECRET:'synthetic-nectar-secret',PLAID_ACCESS_TOKEN:'synthetic-nectar-access',PLAID_ACCOUNT_ID:bankAccount}
let edge,stripe
export function plaidEdge() {
 const transactions=[],calls=[]
 let fail=false
 return {transactions,calls,setFailure(value){fail=value},async fetch(request){
  const path=new URL(request.url).pathname,body=await request.json();calls.push(path)
  if(fail)return Response.json({error_code:'ITEM_LOGIN_REQUIRED'},{status:400})
  assert.equal(body.access_token,settings.PLAID_ACCESS_TOKEN)
  if(path==='/accounts/get')return Response.json({item:{item_id:'synthetic-nectar-bank-item'},accounts:[{account_id:bankAccount,balances:{iso_currency_code:'USD'}}]})
  assert.equal(path,'/transactions/get')
  assert.deepEqual(body.options.account_ids,[bankAccount])
  const selected=transactions.filter(row=>row.date>=body.start_date&&row.date<=body.end_date)
  return Response.json({total_transactions:selected.length,transactions:selected.slice(body.options.offset,body.options.offset+2)})
 }}
}
export const harnessOptions=()=>{edge=plaidEdge();stripe=processorEdge();return {stripeFetch:stripe.fetch,stripeSecret:'synthetic-nectar-1',assets:true,localTime:'2026-10-28T12:00:00Z',plaidFetch:edge.fetch,settings}}
export async function plaidRemittancesFlow(h,owner,{bank=edge,createDeposits,onState=async()=>{}}={}) {
 const api=(path,body,status)=>h.api(path,owner,body,status)
 const factor=await api('mfa.totp.start',{})
 await api('mfa.totp.confirm',{factor:factor.factor,code:totp(factor.secret,Date.parse('2026-10-28T12:00:00Z'))})
 const {customer,other,issue}=await remittanceFixtures(h,owner),invoices=[]
 for(const amount of ['100.01','200.02','300.03','90.00','40.00'])invoices.push(await issue(amount))
 const deposits=[
  {transaction_id:'synthetic-nectar-bank-wire',amount:-600.06,name:invoices.slice(0,3).map(row=>row.number).join(' ')},
  {transaction_id:'synthetic-nectar-bank-ach',amount:-90,name:'ACH remittance advice'},
  {transaction_id:'synthetic-nectar-bank-short',amount:-10,name:invoices[4].number},
  {transaction_id:'synthetic-nectar-bank-unknown',amount:-7,name:'Unidentified deposit'},
 ].map(row=>({...row,account_id:bankAccount,date:'2026-10-15',iso_currency_code:'USD',pending:false}))
 const actual=createDeposits?await createDeposits(deposits):deposits
 if(!createDeposits)bank.transactions.push(...actual,
  {...actual[3],transaction_id:'synthetic-nectar-bank-pending',pending:true,amount:-9},
  {...actual[3],transaction_id:'synthetic-nectar-bank-debit',amount:5})
 const advice=()=>{
  const csv=remittanceFile([[actual[1].transaction_id,'2026-10-15','USD','90.00','synthetic-nectar-901',invoices[3].number,'90.00']])
  return file('synthetic-nectar-remittance.eml',['MIME-Version: 1.0','From: '+['synthetic-nectar-payer','example.test'].join('@'),'Content-Type: '+['multipart','mixed'].join('/')+'; boundary="synthetic-nectar-boundary"','','--synthetic-nectar-boundary','Content-Type: '+['text','plain'].join('/'),'','Remittance advice attached.','--synthetic-nectar-boundary','Content-Type: '+['text','csv'].join('/')+'; name="synthetic-nectar.csv"','Content-Transfer-Encoding: base64','',csv.base64,'--synthetic-nectar-boundary--',''].join('\r\n'))
 }
 const capture={from:'2026-10-15',through:'2026-10-15',confirm:true,file:advice()}
 await api('plaid.capture',{...capture,confirm:false},400)
 const result=await api('plaid.capture',capture)
 assert.equal(result.deposits,4);assert.equal(result.receipts.length,4)
 const after=await api('payments');assert.equal(after.length,3)
 assert.deepEqual(await Promise.all(invoices.map(async row=>(await api('invoices/'+row.id)).balanceCents)),[0,0,0,0,3000])
 const ledger=(await api('customers/'+customer)).ledger
 assert.deepEqual([ledger.invoicedCents,ledger.paidCents,ledger.balanceCents],[73006,70006,3000])
 const queue=await api('remittances'),unknown=queue.find(row=>row.status==='staged')
 await api('remittance.upload',{file:remittanceFile([[queue[0].source.receiptId,'2026-10-15','USD','1.00','','','']])},400)
 assert.ok(unknown);assert.equal(unknown.customer_id,null);assert.equal(unknown.amount_cents,700)
 assert.equal(queue.filter(row=>row.reason==='short_payment').length,1)
 await onState({customer,invoices,unknown})
 await api('plaid.capture',capture)
 assert.deepEqual(await api('payments'),after,'Feed replay never records or allocates a source twice')
 const changed=remittanceFile([[actual[1].transaction_id,'2026-10-15','USD','90.01','synthetic-nectar-901',invoices[3].number,'90.00']])
 await api('plaid.capture',{...capture,file:changed},409)
 assert.deepEqual(await api('payments'),after,'Advice cannot change the bank amount')
 const email=['synthetic-nectar-bank-observer','example.test'].join('@')
 await api('access.give',{email,name:'Bank observer',role:'finance'})
 const finance=await h.signIn(email,{requested:true})
 await h.api('plaid.capture',finance,capture,403)
 const key=await api('credential.issue',{name:'Synthetic bank observer',scopes:['prepare']})
 await h.api('plaid.capture',{bearer:key.key},capture,403)
 await api('credential.revoke',{key:key.id});await h.api('plaid.capture',{bearer:key.key},capture,401)
 if(!createDeposits){
  bank.setFailure(true);await api('plaid.capture',capture,502);bank.setFailure(false)
  assert.deepEqual(await api('payments'),after,'A disconnected bank source changes no cash')
  bank.transactions[0].amount=-600.07
  await api('plaid.capture',capture,409);bank.transactions[0].amount=-600.06
  assert.deepEqual(await api('payments'),after,'Changed bank receipt reuse changes no cash')
 }
 const identified=await api('remittance.preview',{receipt:unknown.id,customer:other})
 await api('remittance.confirm',{receipt:unknown.id,customer:other,fingerprint:identified.fingerprint,confirm:true})
 assert.equal((await api('payments')).length,4)
 assert.equal((await api('customers/'+other)).ledger.paidCents,0,'Unmatched cash does not guess an invoice')
 if(!createDeposits){
  const a=await issue('11.00'),b=await issue('12.00'),c=await issue('15.00')
  bank.transactions.push({transaction_id:'synthetic-nectar-short-advice',account_id:bankAccount,date:'2026-10-16',amount:-15,name:a.number+' '+b.number,iso_currency_code:'USD',pending:false})
  const paymentsBefore=await api('payments')
  await api('plaid.capture',{from:'2026-10-16',through:'2026-10-16',confirm:true})
  assert.deepEqual(await api('payments'),paymentsBefore,'A short multi-invoice reference never falls through to another exact-amount invoice')
  assert.equal((await api('invoices/'+c.id)).balanceCents,1500)
  const held=(await api('remittances')).find(row=>row.received_on==='2026-10-16')
  assert.equal(held.status,'staged');assert.deepEqual(held.preview.allocations,[])
 }
 if(!createDeposits){await bankPayoutFlow(h,owner,{customer,issue,bank,stripe});await bankScreens(h,owner,customer)}
 const request=await api('erasure.request',{customer})
 await api('erasure.verify',{request:request.id,reason:'Synthetic verified bank customer',evidence:file('synthetic-nectar-bank.txt','Synthetic verified identity')})
 await api('erasure.approve',{request:request.id,confirm:true})
 await api('plaid.capture',capture,409)
 assert.equal((await api('remittances')).filter(row=>row.customer_id===customer).length,0)
 console.log('Plaid bank deposits: wire, advice, short payment, unidentified cash, once-only replay and refusals passed')
 return {factorSecret:factor.secret}
}

async function bankPayoutFlow(h,owner,{customer,issue,bank,stripe}) {
 const api=(path,body,status)=>h.api(path,owner,body,status)
 await api('collection.customer.bind',{customer,account_ref:stripe.account,stripe_customer_ref:stripe.customerRef,confirm:true})
 const invoices=[await issue('120.00'),await issue('80.00')]
 const members=[]
 for(const [index,invoice] of invoices.entries()){
  const source=stripe.seed(invoice.id,invoice.total_cents,'bank-payout-'+index)
  members.push(source.transaction.id)
  const event=stripe.event('synthetic-nectar-bank-charge-'+index,'payment_intent.succeeded',source.intent)
  await api('processor.event.consume',{account_ref:stripe.account,event_ref:event.id})
 }
 const payout={object:'payout',id:'synthetic-nectar-bank-payout',status:'paid',amount:19360,currency:'usd',automatic:true,livemode:false,balance_transaction:'synthetic-nectar-bank-payout-debit'}
 stripe.objects.set(payout.id,payout)
 stripe.transactions.set(payout.balance_transaction,{object:'balance_transaction',id:payout.balance_transaction,type:'payout',source:payout.id,amount:-19360,fee:0,net:-19360,currency:'usd',status:'available',created:stripe.at+10,available_on:stripe.at+10})
 stripe.payoutMembers.set(payout.id,[...members,payout.balance_transaction])
 const event=stripe.event('synthetic-nectar-bank-payout-event','payout.paid',payout)
 await api('processor.event.consume',{account_ref:stripe.account,event_ref:event.id})
 const before=await api('payments')
 bank.transactions.push({transaction_id:'synthetic-nectar-bank-payout-deposit',account_id:bankAccount,date:'2026-10-28',amount:-193.60,name:'Stripe '+payout.id,iso_currency_code:'USD',pending:false})
 const capture={from:'2026-10-28',through:'2026-10-28',confirm:true}
 const result=await api('plaid.capture',capture)
 assert.equal(result.payouts.length,1);assert.deepEqual(result.receipts,[])
 const observed=await api('processor-events?customer='+customer)
 assert.equal(observed.bankMatches.length,1);assert.equal(observed.bankMatches[0].amount_cents,19360)
 assert.deepEqual(observed.transactions.filter(row=>members.includes(row.transaction_ref)).map(row=>row.invoice_id).sort(),invoices.map(row=>row.id).sort())
 assert.deepEqual(await api('payments'),before,'Matching a payout never records the already captured gross cash again')
 await api('plaid.capture',capture)
 assert.equal((await api('processor-events')).bankMatches.length,1)
 assert.deepEqual(await api('payments'),before)
 bank.transactions[bank.transactions.length-1].amount=-193.61
 await api('plaid.capture',capture,409)
 assert.deepEqual(await api('payments'),before,'A changed payout deposit cannot change the cash ledger')
 bank.transactions[bank.transactions.length-1].amount=-193.60
}

async function bankScreens(h,owner,customer) {
 const {chromium}=await import('@playwright/test')
 const {mkdir}=await import('node:fs/promises')
 const browser=await chromium.launch({headless:true,executablePath:process.env.NECTAR_CHROMIUM_PATH,args:['--no-sandbox','--use-mock-keychain','--password-store=basic']})
 try{
  const context=await browser.newContext({viewport:{width:1440,height:1000}})
  await context.addCookies(owner.split('; ').map(value=>{const at=value.indexOf('=');return {name:value.slice(0,at),value:value.slice(at+1),url:h.origin}}))
  const page=await context.newPage(),directory=process.env.NECTAR_EVIDENCE_DIR
  if(directory)await mkdir(directory,{recursive:true})
  for(const [name,path] of [['bank-receipts','/app/receivables'],['bank-payout','/app/processor-events?customer='+customer]]){
   await page.goto(h.origin+path)
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'The cash review fits at the asserted desktop width')
   if(name==='bank-payout')assert.equal(await page.locator('#bank-payouts tbody tr').count(),1,'The operator can inspect the reconciled bank payout')
   const icons=await page.locator('a,button').evaluateAll(nodes=>nodes.filter(node=>!node.textContent.trim()&&node.querySelector('svg,img')&&!node.getAttribute('aria-describedby')).map(node=>node.tagName))
   assert.deepEqual(icons,[],'Icon-only controls expose their tooltips')
   if(directory)for(const width of [1440,390]){await page.setViewportSize({width,height:1000});await page.screenshot({path:directory+'/'+name+'-'+width+'.png',fullPage:true})}
   await page.setViewportSize({width:1440,height:1000})
  }
  await context.close()
 }finally{await browser.close()}
}
