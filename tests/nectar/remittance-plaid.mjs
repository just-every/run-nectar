import { chromium } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
// Bank advice uses the ordinary Worker and D1 doors; only Plaid's HTTP edge is faked.
import assert from 'node:assert/strict'
import { file } from './harness.mjs'
import { totp } from './mfa.mjs'
import { csvRows } from './financial-reports.mjs'

export function plaidRemittanceEdge() {
  const account='synthetic-nectar-bank-account',item='synthetic-nectar-bank-item',transactions=[]
  return {account,item,transactions,
    seed(id,amount,date='2026-10-15') {const row={transaction_id:id,account_id:account,amount:-amount,date,iso_currency_code:'USD',pending:false,name:id};transactions.push(row);return row},
    async fetch(request) {
      const body=await request.json(),path=new URL(request.url).pathname
      assert.equal(body.client_id,'synthetic-nectar-plaid-client');assert.equal(body.secret,'synthetic-nectar-plaid-secret');assert.equal(body.access_token,'synthetic-nectar-plaid-access')
      if(path==='/accounts/get')return Response.json({item:{item_id:item,error:null},accounts:[{account_id:account,type:'depository',balances:{iso_currency_code:'USD'}}]})
      if(path==='/transactions/get'){
        const rows=transactions.filter(row=>row.date>=body.start_date&&row.date<=body.end_date)
        return Response.json({item:{item_id:item},total_transactions:rows.length,transactions:rows.slice(body.options.offset,body.options.offset+body.options.count)})
      }
      throw new Error('Unexpected bank provider write')
    },
  }
}
export async function plaidRemittanceFlow(h,owner,edge,makeFile) {
  const api=(path,body,status)=>h.api(path,owner,body,status)
  const at=Date.parse('2026-10-28T12:00:00Z'),factor=await api('mfa.totp.start',{})
  await api('mfa.totp.confirm',{factor:factor.factor,code:totp(factor.secret,at)})
  const customer=(await api('customer.create',{external_id:'synthetic-nectar-bank-customer',name:'Synthetic bank customer',billing_email:['synthetic-nectar-bank-customer','example.test'].join('@')})).id
  const issue=async amount=>{
    const charge=(await api('charge.add',{customer,amount,description:'Bank receipt service',effective_date:'2026-10-01',taxable:false})).charge
    const invoice=(await api('invoice.manual',{customer,charges:[charge],service_date:'2026-10-01'})).id
    await api('invoice.approve',{invoice,acknowledge:true});await api('invoice.finalise',{invoice,issue_date:'2026-10-01'})
    return api(`invoices/${invoice}`)
  }
  const invoices=[];for(const amount of ['10.01','20.02','30.03','40.00','90.00','50.00'])invoices.push(await issue(amount))
  const rows=(id,amount,lines=[],who='synthetic-nectar-bank-customer')=>(lines.length?lines:[['','']]).map(([number,allocation])=>[id,'2026-10-15','USD',amount,who,number,allocation])
  const wire=edge.seed('synthetic-nectar-bank-wire',60.06)
  const wireFile=makeFile(rows(wire.transaction_id,'60.06',invoices.slice(0,3).map((invoice,i)=>[invoice.number,['10.01','20.02','30.03'][i]])))
  const preview=(file,status)=>api('bank.remittance.preview',{account:edge.account,file},status)
  const confirm=(file,prepared,status)=>api('bank.remittance.confirm',{account:edge.account,file,fingerprint:prepared.fingerprint,confirm:true},status)
  const initial=await api('payments'),prepared=await preview(wireFile)
  assert.equal(prepared.receipts[0].autoApply,true);assert.equal(prepared.receipts[0].preview.allocatedCents,6006)
  assert.deepEqual(await api('payments'),initial,'Reading Plaid and previewing advice changes no money')
  const body={account:edge.account,file:wireFile,fingerprint:prepared.fingerprint,confirm:true}
  const race=await Promise.all([1,2].map(()=>h.raw('/api/nectar/bank.remittance.confirm',{cookie:owner,body})))
  assert.ok(race.every(response=>[200,409].includes(response.status)));assert.ok(race.some(response=>response.status===200));for(const response of race)await response.text()
  assert.equal((await api('payments')).length,initial.length+1)
  for(const invoice of invoices.slice(0,3))assert.equal((await api(`invoices/${invoice.id}`)).balanceCents,0)
  assert.equal((await confirm(wireFile,prepared)).duplicate,true)
  const afterWire=await api('payments');assert.deepEqual(await api('payments'),afterWire)
  const ach=edge.seed('synthetic-nectar-bank-ach',40),short=edge.seed('synthetic-nectar-bank-short',60),unknown=edge.seed('synthetic-nectar-bank-unknown',17.11)
  const batch=makeFile([...rows(ach.transaction_id,'40.00',[[invoices[3].number,'40.00']]),...rows(short.transaction_id,'60.00',[[invoices[4].number,'60.00']]),...rows(unknown.transaction_id,'17.11',[],'')])
  const proposal=await preview(batch)
  const snapshot={payments:await api('payments'),receipts:await api('remittances')}
  await h.rejectAudit('bank.remittance.confirm')
  assert.equal((await h.raw('/api/nectar/bank.remittance.confirm',{cookie:owner,body:{account:edge.account,file:batch,fingerprint:proposal.fingerprint,confirm:true}})).status,500)
  await h.rejectAudit(null)
  assert.deepEqual({payments:await api('payments'),receipts:await api('remittances')},snapshot,'The bank source, receipt and all allocations roll back with audit failure')
  await confirm(batch,proposal)
  assert.equal((await api(`invoices/${invoices[4].id}`)).balanceCents,3000)
  await bankQueueScreens(h,owner,{invoice:invoices[4],owed:'$30.00'})
  const unknownId=proposal.receipts.find(row=>row.source===unknown.transaction_id).id
  assert.equal((await api('remittances')).find(row=>row.id===unknownId).payment_id,null,'An unidentified bank deposit is queued without a payment')
  const identified=await api('remittance.preview',{receipt:unknownId,customer})
  assert.equal(identified.allocations.length,0)
  await api('remittance.confirm',{receipt:unknownId,customer,fingerprint:identified.fingerprint,confirm:true})
  const allocation=await api('remittance.allocate.preview',{receipt:unknownId,invoice:invoices[5].id,amount:'10.00'})
  await api('remittance.allocate',{receipt:unknownId,invoice:invoices[5].id,amount:'10.00',fingerprint:allocation.fingerprint,confirm:true})
  assert.equal((await api(`invoices/${invoices[5].id}`)).balanceCents,4000)
  const ledger=(await api(`customers/${customer}`)).ledger
  assert.equal(ledger.invoicedCents,24006);assert.equal(ledger.paidCents,17006);assert.equal(ledger.balanceCents,7000);assert.equal(ledger.unallocatedCents,711)
  const report=await api(`reports/collections?period=2026-10&customer=${customer}`);assert.equal(report.totalCents,17717)
  const exported=csvRows(await(await h.raw(`/app/exports/reports/collections.csv?period=2026-10&customer=${customer}`,{cookie:owner})).text())
  assert.equal(exported.find(row=>row.source==='TOTAL').amount,'177.17')
  const stale=edge.seed('synthetic-nectar-bank-stale',10)
  const staleFile=makeFile(rows(stale.transaction_id,'10.00',[[invoices[4].number,'10.00']]))
  const stalePreview=await preview(staleFile)
  const manual=(await api('payment.record',{customer,amount:'1.00',received_on:'2026-10-15',method:'check',reference:'synthetic-nectar-bank-manual'})).payment
  await api('payment.allocate',{payment:manual,invoice:invoices[4].id,amount:'1.00'})
  const beforeStale=await api('payments');await confirm(staleFile,stalePreview,409);assert.deepEqual(await api('payments'),beforeStale)
  stale.pending=true;await preview(staleFile,409);stale.pending=false
  stale.iso_currency_code='CAD';await preview(staleFile,409);stale.iso_currency_code='USD'
  stale.amount=-11;await preview(staleFile,409);stale.amount=-10
  await api('bank.remittance.preview',{account:'synthetic-nectar-foreign-bank',file:staleFile},409)
  wire.amount=-60.07
  await preview(makeFile(rows(wire.transaction_id,'60.07',invoices.slice(0,3).map((invoice,i)=>[invoice.number,['10.01','20.02','30.03'][i]]))),409)
  wire.amount=-60.06
  const finance=['synthetic-nectar-bank-finance','example.test'].join('@')
  await api('access.give',{email:finance,name:'Synthetic bank finance',role:'finance'})
  const financeCookie=await h.signIn(finance,{requested:true})
  for(const action of ['bank.remittance.preview','bank.remittance.confirm'])await h.api(action,financeCookie,{},403)
  await h.advanceClock('2026-10-28T12:16:00Z');await preview(staleFile,403)
  await api('mfa.verify',{code:totp(factor.secret,Date.parse('2026-10-28T12:16:00Z'))})
  const request=await api('erasure.request',{customer})
  await api('erasure.verify',{request:request.id,reason:'Independent bank customer verification',evidence:file('synthetic-nectar-bank-verification.txt','Synthetic signed customer verification')})
  await api('erasure.approve',{request:request.id,confirm:true})
  await preview(wireFile,409)
  assert.equal((await api('cash-application-queue')).some(row=>row.customer===customer),false)
  await h.assertStorageExcludes(['synthetic-nectar-plaid-secret','synthetic-nectar-plaid-access','synthetic-nectar-bank-customer'])
  console.log('Posted Plaid receipt capture, automatic advice application, queued identification, money refusals and erasure passed')
}

export async function bankQueueScreens(h,owner,{invoice,owed}) {
 const browser=await chromium.launch({headless:true,executablePath:process.env.NECTAR_CHROMIUM_PATH,args:['--no-sandbox','--use-mock-keychain','--password-store=basic']})
 try {
  const context=await browser.newContext({viewport:{width:1440,height:950}})
  await context.addCookies(owner.split('; ').map(part=>{const at=part.indexOf('=');return {name:part.slice(0,at),value:part.slice(at+1),url:h.origin}}))
  const page=await context.newPage();await page.goto(h.origin+'/app/receivables')
  const queue=page.locator('#cash-application-queue')
  assert.match(await queue.innerText(),/Posted sandbox bank deposit/)
  assert.match(await queue.innerText(),/Awaiting receipt confirmation/)
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Bank review fits the ordinary desktop viewport')
  if(process.env.NECTAR_EVIDENCE_DIR){
   await mkdir(process.env.NECTAR_EVIDENCE_DIR,{recursive:true})
   for(const width of [1440,390]){await page.setViewportSize({width,height:950});await queue.screenshot({path:`${process.env.NECTAR_EVIDENCE_DIR}/posted-bank-queue-${width}.png`})}
  }
  await page.setViewportSize({width:1440,height:950})
  await queue.locator('tr').filter({hasText:'Posted sandbox bank deposit'}).filter({hasText:'Short payment'}).getByRole('link',{name:'Review receipt'}).click()
  const review=page.locator('#remittance-review')
  assert.match(await review.innerText(),new RegExp(owed.replace('$','\\$').replace('.','\\.')))
  assert.equal(await review.locator(`a[href="/app/invoices/${invoice.id}"]`).innerText(),invoice.number,'Short-payment review opens the exact unpaid invoice')
  if(process.env.NECTAR_EVIDENCE_DIR)for(const width of [1440,390]){await page.setViewportSize({width,height:950});await review.screenshot({path:`${process.env.NECTAR_EVIDENCE_DIR}/posted-bank-short-review-${width}.png`})}
  await context.close()
 }finally{await browser.close()}
}
