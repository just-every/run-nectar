import { applyPolicy } from './policy-helper.mjs'
// Real Worker and D1; cash, matching and refusal use only public doors.
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { file } from './harness.mjs'
import { csvRows } from './financial-reports.mjs'

export const harnessOptions = () => ({ assets: true, localTime: '2026-10-28T12:00:00Z' })
const header = 'receipt_id,received_on,currency,amount,customer,invoice_reference,allocation_amount\n'
export const remittanceFile = rows => file('synthetic-nectar-900.csv',header+rows.map(row=>row.join(',')).join('\n')+'\n')
export async function remittanceFixtures(h, owner) {
  const api=(path,body,status)=>h.api(path,owner,body,status)
  const customer=(await api('customer.create',{external_id:'synthetic-nectar-901',name:'Synthetic remittance customer',billing_email:['synthetic-nectar-901','example.test'].join('@')})).id
  const other=(await api('customer.create',{external_id:'synthetic-nectar-902',name:'Synthetic other customer',billing_email:['synthetic-nectar-902','example.test'].join('@')})).id
  const issue=async(amount,customerId=customer)=>{
    const charge=await api('charge.add',{customer:customerId,amount,description:'Synthetic service',effective_date:'2026-10-01',taxable:false})
    const draft=await api('invoice.manual',{customer:customerId,charges:[charge.charge],service_date:'2026-10-01'})
    await api('invoice.approve',{invoice:draft.id,acknowledge:true})
    await api('invoice.finalise',{invoice:draft.id,issue_date:'2026-10-01'})
    return api(`invoices/${draft.id}`)
  }
  return {customer,other,issue}
}
export async function remittanceFilesFlow(h, owner) {
  const api=(path,body,status)=>h.api(path,owner,body,status), {customer,other,issue}=await remittanceFixtures(h,owner)
  const invoices=[];for(const amount of ['100.01','200.02','300.03','90.00','40.00'])invoices.push(await issue(amount))
  const foreign=await issue('10.00',other)
  const rows=(id,amount,lines=[],who='synthetic-nectar-901',currency='USD')=>(lines.length?lines:[['','']]).map(([reference,allocated])=>[id,'2026-10-15',currency,amount,who,reference,allocated])
  const upload=async data=>(await api('remittance.upload',{file:remittanceFile(data)})).id
  const preview=(receipt,extra={})=>api('remittance.preview',{receipt,...extra})
  const confirm=(receipt,p,status)=>api('remittance.confirm',{receipt,customer:p.customer??'',fingerprint:p.fingerprint,confirm:true},status)
  const state=async()=>({payments:await api('payments'),invoices:await Promise.all(invoices.map(i=>api(`invoices/${i.id}`)))})
  const wireRows=rows('synthetic-nectar-910','600.06',invoices.slice(0,3).map((i,n)=>[i.number,['100.01','200.02','300.03'][n]]))
  const wire=await upload(wireRows), initial=await state(), match=await preview(wire)
  assert.equal(match.allocatedCents,60006)
  assert.deepEqual(match.allocations.map(a=>a.amountCents).sort((a,b)=>a-b),[10001,20002,30003])
  assert.deepEqual(await state(),initial,'Uploading and previewing cannot record or allocate money')
  assert.deepEqual((await api('remittance.upload',{file:remittanceFile(wireRows)})).receipts,[wire],'File replay retains the receipt identity')
  const race=await Promise.all([1,2].map(()=>h.raw('/api/nectar/remittance.confirm',{cookie:owner,body:{receipt:wire,fingerprint:match.fingerprint,confirm:true}})))
  assert.ok(race.every(r=>[200,409].includes(r.status)));assert.ok(race.some(r=>r.status===200))
  for(const r of race)await r.text()
  const paid=(await api('remittances')).find(r=>r.id===wire), receipt=await api(`payments/${paid.payment_id}/receipt`)
  assert.equal(receipt.amountCents,60006);assert.equal(receipt.allocatedCents,60006);assert.equal(receipt.allocations.length,3)
  assert.equal((await api('payments')).length,1)
  const completed=await state();assert.equal((await confirm(wire,match)).duplicate,true);assert.deepEqual(await state(),completed)
  assert.equal((await api('remittance.upload',{file:remittanceFile(rows('synthetic-nectar-910','600.07',invoices.slice(0,3).map((i,n)=>[i.number,['100.01','200.02','300.03'][n]])))},409)).error,'remittance_source_changed')
  const short=await upload(rows('synthetic-nectar-911','60.00',[[invoices[3].number,'60.00']]))
  const shortPreview=await preview(short);assert.equal(shortPreview.reason,'short_payment')
  await confirm(short,shortPreview)
  assert.equal((await api(`invoices/${invoices[3].id}`)).balanceCents,3000)
  const shortQueue=(await api('remittances')).find(r=>r.id===short)
  assert.equal(shortQueue.reason,'short_payment');assert.equal(shortQueue.short[0].balance_cents,3000)
  const unknown=await upload(rows('synthetic-nectar-912','40.00',[],''))
  const unknownPreview=await preview(unknown);assert.equal(unknownPreview.customer,null);assert.equal(unknownPreview.reason,'unidentified_customer')
  const beforeUnknown=await state();await confirm(unknown,unknownPreview,409);assert.deepEqual(await state(),beforeUnknown)
  const assigned=await preview(unknown,{customer:other})
  // A person may identify an unknown deposit, but foreign invoices remain unavailable.
  const assignedResult=await confirm(unknown,assigned)
  const unallocatedBefore=await api(`payments/${assignedResult.payment}/receipt`);assert.equal(unallocatedBefore.unallocatedCents,4000)
  const heldBalance=await api(`customers/${other}/balance`)
  assert.equal(heldBalance.cashCents,4000);assert.equal(heldBalance.queuedCashCents,4000)
  assert.equal((await api(`./reports/credit-balances?customer=${other}`)).totalCents,4000,'Queued cash remains in financial reports while excluded from automatic application')
  const heldCsv=csvRows(await(await h.raw(`/app/exports/reports/credit-balances.csv?customer=${other}`,{cookie:owner})).text())
  assert.equal(heldCsv.find(row=>row.source==='TOTAL').amount,'40.00')
  await api('remittance.allocate.preview',{receipt:unknown,invoice:invoices[4].id,amount:'10.00'},409)
  const allocation=await api('remittance.allocate.preview',{receipt:unknown,invoice:foreign.id,amount:'10.00'})
  const allocationBody={receipt:unknown,invoice:foreign.id,amount:'10.00',fingerprint:allocation.fingerprint,confirm:true}
  await api('remittance.allocate',{...allocationBody,confirm:false},400)
  await api('payment.allocate',{payment:assignedResult.payment,invoice:foreign.id,amount:'10.00'},409)
  await h.rejectAudit('remittance.allocate')
  assert.equal((await h.raw('/api/nectar/remittance.allocate',{cookie:owner,body:allocationBody})).status,500)
  await h.rejectAudit(null)
  assert.deepEqual(await api(`payments/${assignedResult.payment}/receipt`),unallocatedBefore,'An audit failure rolls back every allocation')
  await api('balance.apply',{invoice:foreign.id},409)
  assert.deepEqual(await api(`payments/${assignedResult.payment}/receipt`),unallocatedBefore,'Customer balance application cannot bypass receipt review')
  const allocated=await api('remittance.allocate',allocationBody)
  assert.equal((await api('remittance.allocate',allocationBody)).allocation,allocated.allocation)
  assert.equal((await api(`payments/${assignedResult.payment}/receipt`)).unallocatedCents,3000)
  assert.equal((await api(`invoices/${foreign.id}`)).balanceCents,0)
  await applyPolicy(h,owner,'credit.policy',{balance_application:'automatic'})
  const automatic=await issue('5.00',other)
  assert.equal(automatic.balanceCents,500,'An automatic customer-balance policy leaves queued remittance cash for its separately confirmed door')
  assert.equal((await api(`payments/${assignedResult.payment}/receipt`)).unallocatedCents,3000)
  const written=await api('writeoff.issue',{invoice:automatic.id,amount:'5.00',reason:'Synthetic receivable review'})
  await api('writeoff.recover',{write_off:written.writeOff,payment:assignedResult.payment,amount:'1.00'},409)
  assert.equal((await api(`payments/${assignedResult.payment}/receipt`)).unallocatedCents,3000,'Write-off recovery cannot consume queued cash')
  // A different payment changes a reviewed balance before source confirmation.
  const stale=await upload(rows('synthetic-nectar-913','20.00',[[invoices[3].number,'20.00']]))
  const old=await preview(stale)
  const manual=(await api('payment.record',{customer,amount:'1.00',received_on:'2026-10-15',method:'check',reference:'synthetic-nectar-914'})).payment
  await api('payment.allocate',{payment:manual,invoice:invoices[3].id,amount:'1.00'})
  const changed=await state();await confirm(stale,old,409);assert.deepEqual(await state(),changed)
  const refreshed=await preview(stale)
  await h.rejectAudit('remittance.confirm')
  assert.equal((await h.raw('/api/nectar/remittance.confirm',{cookie:owner,body:{receipt:stale,fingerprint:refreshed.fingerprint,confirm:true}})).status,500)
  await h.rejectAudit(null);assert.deepEqual(await state(),changed,'Receipt, allocations and source claim all roll back with audit failure')
  await confirm(stale,refreshed)
  await api('remittance.upload',{file:remittanceFile(rows('synthetic-nectar-915','1.00',[],'synthetic-nectar-901','CAD'))},400)
  await api('remittance.upload',{file:remittanceFile(rows('synthetic-nectar-916','10.00',[[foreign.number,'10.00']]))},409)
  await api('remittance.upload',{file:remittanceFile(rows('synthetic-nectar-917','1.001'))},400)
  const ambiguousInvoices=[await issue('12.00',other),await issue('12.00',other)]
  const ambiguous=await upload(rows('synthetic-nectar-921','12.00',[],'synthetic-nectar-902'))
  const ambiguousPreview=await preview(ambiguous)
  assert.equal(ambiguousPreview.reason,'ambiguous_amount');assert.deepEqual(ambiguousPreview.allocations,[])
  const ambiguousPayment=(await confirm(ambiguous,ambiguousPreview)).payment
  const stagedAllocation=await api('remittance.allocate.preview',{receipt:ambiguous,invoice:ambiguousInvoices[0].id,amount:'5.00'})
  const reducingPayment=(await api('payment.record',{customer:other,amount:'1.00',received_on:'2026-10-15',method:'check',reference:'synthetic-nectar-922'})).payment
  await api('payment.allocate',{payment:reducingPayment,invoice:ambiguousInvoices[0].id,amount:'1.00'})
  const beforeStale=await api(`payments/${ambiguousPayment}/receipt`)
  await api('remittance.allocate',{receipt:ambiguous,invoice:ambiguousInvoices[0].id,amount:'5.00',fingerprint:stagedAllocation.fingerprint,confirm:true},409)
  assert.deepEqual(await api(`payments/${ambiguousPayment}/receipt`),beforeStale)
  const freshAllocation=await api('remittance.allocate.preview',{receipt:ambiguous,invoice:ambiguousInvoices[0].id,amount:'5.00'})
  const concurrentAllocation=await Promise.all([1,2].map(()=>h.raw('/api/nectar/remittance.allocate',{cookie:owner,body:{receipt:ambiguous,invoice:ambiguousInvoices[0].id,amount:'5.00',fingerprint:freshAllocation.fingerprint,confirm:true}})))
  assert.ok(concurrentAllocation.every(r=>[200,409].includes(r.status)))
  assert.ok(concurrentAllocation.some(r=>r.status===200));for(const r of concurrentAllocation)await r.text()
  assert.equal((await api(`payments/${ambiguousPayment}/receipt`)).allocatedCents,500)
  await api('customer.create',{external_id:'synthetic-nectar-923',name:'Synthetic Canadian customer',billing_email:['synthetic-nectar-923','example.test'].join('@'),currency:'CAD'})
  await api('remittance.upload',{file:remittanceFile(rows('synthetic-nectar-924','1.00',[],'synthetic-nectar-923'))},409)
  const outsider=['synthetic-nectar-918','example.test'].join('@')
  await api('access.give',{email:outsider,name:'Read only member',role:'accountant'})
  const readOnly=await h.signIn(outsider,{requested:true})
  for(const action of ['bank.deposit.upload','remittance.upload','remittance.preview','remittance.confirm','remittance.allocate.preview','remittance.allocate'])await h.api(action,readOnly,{},403)
  const key=await api('credential.issue',{name:'Synthetic capture reader',scopes:['prepare']})
  for(const action of ['bank.deposit.upload','remittance.upload','remittance.preview','remittance.confirm','remittance.allocate.preview','remittance.allocate'])await h.api(action,{bearer:key.key},{},403)
  await api('credential.revoke',{key:key.id});await h.api('remittance.confirm',{bearer:key.key},{receipt:wire,fingerprint:match.fingerprint,confirm:true},401)
  const customerView=await api(`customers/${customer}`), ledger=customerView.ledger
  assert.equal(ledger.invoicedCents,73006);assert.equal(ledger.paidCents,68106);assert.equal(ledger.balanceCents,4900)
  const report=await api(`./reports/collections?period=2026-10&customer=${customer}`)
  assert.equal(report.totalCents,68106)
  const csv=await h.raw(`/app/exports/reports/collections.csv?period=2026-10&customer=${customer}`,{cookie:owner})
  const exported=csvRows(await csv.text());assert.equal(exported.find(row=>row.source==='TOTAL').amount,'681.06')
  assert.equal(exported.filter(row=>row.source!=='TOTAL').reduce((sum,row)=>sum+Math.round(Number(row.amount)*100),0),68106)
  const ar=await api(`./reports/ar?customer=${customer}`);assert.equal(ar.totalCents,4900)
  const fullList=await api('remittances'),seen=[]
  let page=await api('remittances?limit=2')
  for(let count=0;;count++){
    assert.ok(count<10,'Receipt pagination terminates')
    seen.push(...page.data.map(row=>row.id))
    if(!page.next_cursor)break
    page=await api(`remittances?limit=2&cursor=${encodeURIComponent(page.next_cursor)}`)
  }
  assert.deepEqual(new Set(seen),new Set([wire,short,unknown,stale,ambiguous]),'Every staged and confirmed source remains reachable through paged receipt review')
  assert.equal(seen.length,5,'No source repeats across pages')
  assert.deepEqual(seen,fullList.map(row=>row.id),'Cursor pages preserve receipt order')
  await remittanceScreens(h,owner,{customer,invoice:invoices[4],rows})
  const erasedRequest=await api('erasure.request',{customer})
  await api('erasure.verify',{request:erasedRequest.id,reason:'Independent customer identity confirmed',evidence:file('synthetic-nectar-919.txt','Synthetic signed verification')})
  await api('erasure.approve',{request:erasedRequest.id,confirm:true})
  const erasedLedger=(await api(`customers/${customer}`)).ledger
  assert.equal(erasedLedger.paidCents,ledger.paidCents+1000)
  assert.equal((await api('remittances')).some(r=>r.customer_id===customer),false)
  await api('remittance.upload',{file:remittanceFile(wireRows)},409)
  await confirm(wire,match,409)
  await api('remittance.allocate.preview',{receipt:wire,invoice:invoices[4].id,amount:'1.00'},409)
  await h.assertStorageExcludes(['synthetic-nectar-901','synthetic-nectar-910','synthetic-nectar-911','synthetic-nectar-913'])
  await crossSourcePayments(h,owner,{issue})
  console.log('Remittance public-door money, refusal, reconciliation, erasure and browser journey passed')
}

async function remittanceScreens(h,owner,{customer,invoice,rows}) {
  const browser=await chromium.launch({headless:true,executablePath:process.env.NECTAR_CHROMIUM_PATH,args:['--no-sandbox','--use-mock-keychain','--password-store=basic']})
  try {
    const context=await browser.newContext({viewport:{width:1440,height:950}})
    await context.addCookies(owner.split('; ').map(value=>{const i=value.indexOf('=');return {name:value.slice(0,i),value:value.slice(i+1),url:h.origin}}))
    const page=await context.newPage(), directory=process.env.NECTAR_EVIDENCE_DIR
    if(directory)await mkdir(directory,{recursive:true})
    const capture=async name=>{
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${name} fits at 1440`)
      if(directory)for(const width of [1440,390]){await page.setViewportSize({width,height:950});await page.screenshot({path:`${directory}/${name}-${width}.png`,fullPage:true})}
      await page.setViewportSize({width:1440,height:950})
    }
    const submit=async action=>{
      const form=page.locator(`form[action="/app/do/${action}"]`)
      await Promise.all([page.waitForNavigation({waitUntil:'load'}),form.locator('button[type=submit]').click()])
      assert.equal(new URL(page.url()).searchParams.get('error'),null)
    }
    await page.goto(h.origin+'/app/receivables')
    await page.getByText('Upload a remittance file',{exact:true}).click()
    const input=page.getByLabel('Remittance CSV',{exact:true}),upload=remittanceFile(rows('synthetic-nectar-920','10.00',[],''))
    await input.setInputFiles({name:upload.filename,mimeType:['text','csv'].join('/'),buffer:Buffer.from(upload.base64,'base64')})
    await submit('remittance.upload')
    const queued=page.locator('#remittances tbody tr').filter({hasText:'synthetic-nectar-920'})
    assert.match(await queued.innerText(),/Customer needs identification/)
    await capture('remittance-queue')
    await queued.getByRole('link',{name:'Review receipt'}).click()
    await page.getByLabel('Customer identified by a person').selectOption(customer)
    await Promise.all([page.waitForNavigation({waitUntil:'load'}),page.getByRole('button',{name:'Review identified customer'}).click()])
    await capture('remittance-confirmation')
    await page.getByLabel('I confirm these received funds and the listed allocations').check()
    await submit('remittance.confirm')
    await page.goto(`${h.origin}/app/customers/${customer}`)
    assert.match(await page.locator('section[aria-labelledby="balance"]').innerText(),/\$10.00/,'The customer sees the cash awaiting allocation')
    await capture('customer-remittance-balance')
    await page.goto(`${h.origin}/app/invoices/${invoice.id}`)
    assert.equal(await page.locator('form[action="/app/do/payment.allocate"]').count(),0,'The invoice directs held receipt funds to their separate review')
    await capture('invoice-remittance-review')
    await page.locator('a[href="/app/receivables#remittances"]').click()
    await page.locator('#remittances tbody tr').filter({hasText:'synthetic-nectar-920'}).getByRole('link',{name:'Review receipt'}).click()
    await page.getByLabel('Invoice',{exact:true}).selectOption(invoice.id)
    await page.getByLabel('Amount ($)',{exact:true}).first().fill('10.00')
    await Promise.all([page.waitForNavigation({waitUntil:'load'}),page.getByRole('button',{name:'Preview allocation',exact:true}).click()])
    assert.match(await page.locator('#remittance-review').innerText(),/balance after \$30.00/)
    await capture('remittance-allocation-preview')
    await page.getByLabel('I confirm this exact allocation').check();await submit('remittance.allocate')
    assert.match(await page.locator('#remittances tbody tr').filter({hasText:'synthetic-nectar-920'}).innerText(),/Allocated/)
    await capture('remittance-allocated')
    const icons=page.locator('#remittances button, #remittances a')
    assert.ok((await icons.allTextContents()).every(text=>text.trim()),'All new controls have visible text')
    await context.close()
  } finally {await browser.close()}
}

// One money journey covers both capture orders and the unsafe duplicate path.
async function crossSourcePayments(h,owner,{issue}) {
  const api=(path,body,status)=>h.api(path,owner,body,status)
  const customer=(await api('customer.create',{external_id:'synthetic-nectar-930',name:'Synthetic source reconciliation',billing_email:['synthetic-nectar-930','example.test'].join('@')})).id
  const invoice=await issue('10.00',customer), reverseInvoice=await issue('10.00',customer)
  const rows=(id,number,amount='10.00')=>[[id,'2026-10-15','USD',amount,'synthetic-nectar-930',number,amount]]
  const original=remittanceFile(rows('synthetic-nectar-931',invoice.number)), bankId='synthetic-nectar-932'
  const snapshot=async()=>({payments:(await api('payments')).filter(p=>p.customer_id===customer),invoice:await api(`invoices/${invoice.id}`),reverse:await api(`invoices/${reverseInvoice.id}`)})
  const confirm=async(source,status)=>{
    const preview=await api('remittance.preview',{receipt:source.id,source:source.source})
    return api('remittance.confirm',{receipt:source.id,source:source.source,customer:preview.customer,fingerprint:preview.fingerprint,confirm:true},status)
  }
  // Native forms perform deposit then identical ordinary CSV, including both confirmations.
  const browser=await chromium.launch({headless:true,executablePath:process.env.NECTAR_CHROMIUM_PATH,args:['--no-sandbox','--use-mock-keychain','--password-store=basic']})
  let payment
  try {
    const context=await browser.newContext({viewport:{width:1440,height:1000}})
    await context.addCookies(owner.split('; ').map(value=>{const i=value.indexOf('=');return {name:value.slice(0,i),value:value.slice(i+1),url:h.origin}}))
    const page=await context.newPage(), directory=process.env.NECTAR_EVIDENCE_DIR
    if(directory)await mkdir(directory,{recursive:true})
    const capture=async name=>{
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${name} fits at 1440`)
      if(directory)for(const width of [1440,390]){await page.setViewportSize({width,height:1000});await page.screenshot({path:`${directory}/${name}-${width}.png`,fullPage:true})}
      await page.setViewportSize({width:1440,height:1000})
    }
    const submit=async action=>{
      const form=page.locator(`form[action="/app/do/${action}"]`)
      await Promise.all([page.waitForNavigation({waitUntil:'load'}),form.locator('button[type=submit]').click()])
      assert.equal(new URL(page.url()).searchParams.get('error'),null,`Native ${action} succeeds`)
    }
    const setCsv=label=>page.getByLabel(label,{exact:true}).setInputFiles({name:original.filename,mimeType:['text','csv'].join('/'),buffer:Buffer.from(original.base64,'base64')})
    const review=async()=>page.locator('#remittances tbody tr').filter({hasText:'synthetic-nectar-931'}).getByRole('link',{name:'Review source',exact:true}).click()
    await page.goto(h.origin+'/app/receivables')
    await page.getByText('Record a bank deposit',{exact:true}).click()
    await page.getByLabel('Bank source ID',{exact:true}).fill(bankId);await setCsv('Bank deposit CSV')
    const before=await snapshot();await submit('bank.deposit.upload');assert.deepEqual(await snapshot(),before,'Staging a deposit creates no money')
    await review();await capture('bank-deposit-review')
    await page.getByLabel('I confirm these received funds and the listed allocations').check();await submit('remittance.confirm')
    const afterBank=await snapshot()
    assert.equal(afterBank.payments.length,1);payment=afterBank.payments[0].id
    assert.equal(afterBank.payments[0].amount_cents,1000);assert.equal(afterBank.invoice.balanceCents,0)
    await page.getByText('Upload a remittance file',{exact:true}).click();await setCsv('Remittance CSV');await submit('remittance.upload')
    assert.deepEqual(await snapshot(),afterBank,'Uploading the identical ordinary CSV changes no payment or invoice')
    await review()
    assert.match(await page.locator('#remittance-review').innerText(),/existing payment without changing its amount or allocations/)
    await capture('ordinary-source-reconciliation')
    await page.getByLabel('I confirm these received funds and the listed allocations').check();await submit('remittance.confirm')
    assert.deepEqual(await snapshot(),afterBank,'Confirming the duplicate source cannot count the ten dollars twice')
    await page.goto(`${h.origin}/app/payments/${payment}/receipt`)
    const sources=page.locator('section').filter({has:page.getByRole('heading',{name:'Recorded sources',exact:true})})
    assert.match(await sources.innerText(),/Bank deposit/);assert.match(await sources.innerText(),/Ordinary remittance/)
    assert.match(await sources.innerText(),/synthetic-nectar-931/);assert.match(await sources.innerText(),/synthetic-nectar-932/)
    await capture('reconciled-payment-sources')
    await context.close()
  } finally {await browser.close()}
  const receipt=await api(`payments/${payment}/receipt`)
  assert.equal(receipt.amountCents,1000);assert.equal(receipt.allocatedCents,1000);assert.equal(receipt.allocations.length,1)
  assert.deepEqual(receipt.recordedSources.map(s=>[s.kind,s.reference]),[['bank_deposit',bankId],['ordinary_remittance','synthetic-nectar-931']])
  const both=await api('remittances'), first=both.find(r=>r.payment_id===payment)
  assert.equal(first.origins.length,2);assert.ok(first.origins.every(s=>s.confirmed_at!==null))
  const audit=(await api('audit')).filter(a=>a.subject===payment)
  const reconciled=audit.find(a=>a.action==='remittance.reconcile')
  assert.ok(reconciled,'Reconciliation is audited against the original payment')
  assert.match(JSON.stringify(reconciled),/bank_deposit/);assert.match(JSON.stringify(reconciled),/ordinary_remittance/)
  assert.match(JSON.stringify(reconciled),/synthetic-nectar-931/);assert.match(JSON.stringify(reconciled),/synthetic-nectar-932/)
  const same=await api('remittance.upload',{file:original})
  assert.equal(same.id,first.id);assert.equal((await confirm(same)).payment,payment)
  const bankReplay=await api('bank.deposit.upload',{bank_source_id:bankId,file:original})
  assert.equal(bankReplay.id,first.id);assert.equal((await confirm(bankReplay)).payment,payment)
  const beforeUnsafe=await snapshot()
  await api('bank.deposit.upload',{bank_source_id:bankId,file:remittanceFile(rows('synthetic-nectar-933',invoice.number))},409)
  await api('remittance.upload',{file:remittanceFile(rows('synthetic-nectar-931',invoice.number,'11.00'))},409)
  assert.deepEqual(await snapshot(),beforeUnsafe,'Changed identities or amounts cannot acquire another payment')
  // Reverse order and an audit failure on the second source: no extra payment or allocation.
  const reverseCsv=remittanceFile(rows('synthetic-nectar-934',reverseInvoice.number))
  const ordinary=await api('remittance.upload',{file:reverseCsv}), originalPayment=(await confirm(ordinary)).payment
  const reverseBank=await api('bank.deposit.upload',{bank_source_id:'synthetic-nectar-935',file:reverseCsv})
  assert.equal(reverseBank.id,ordinary.id)
  const unchanged=await snapshot(), pending=await api('remittance.preview',{receipt:reverseBank.id,source:reverseBank.source})
  const body={receipt:reverseBank.id,source:reverseBank.source,fingerprint:pending.fingerprint,confirm:true}
  await h.rejectAudit('remittance.reconcile')
  assert.equal((await h.raw('/api/nectar/remittance.confirm',{cookie:owner,body})).status,500)
  await h.rejectAudit(null)
  assert.equal((await api(`payments/${originalPayment}/receipt`)).recordedSources.length,1,'Audit failure rolls back the second source confirmation')
  assert.deepEqual(await snapshot(),unchanged)
  const attempts=await Promise.all([1,2].map(()=>h.raw('/api/nectar/remittance.confirm',{cookie:owner,body})))
  assert.ok(attempts.every(r=>[200,409].includes(r.status)));assert.ok(attempts.some(r=>r.status===200));for(const r of attempts)await r.text()
  assert.equal((await confirm(reverseBank)).payment,originalPayment)
  assert.deepEqual(await snapshot(),unchanged)
  const reversed=await api(`payments/${originalPayment}/receipt`)
  assert.equal(reversed.amountCents,1000);assert.equal(reversed.allocatedCents,1000);assert.equal(reversed.allocations.length,1);assert.equal(reversed.recordedSources.length,2)
  assert.equal((await snapshot()).payments.reduce((sum,p)=>sum+p.amount_cents,0),2000,'Two different ten-dollar receipts remain two payments in total')
  const erasure=await api('erasure.request',{customer})
  await api('erasure.verify',{request:erasure.id,reason:'Synthetic identity verified',evidence:file('synthetic-nectar-936.txt','Synthetic signed verification')})
  await api('erasure.approve',{request:erasure.id,confirm:true})
  assert.deepEqual((await api(`payments/${payment}/receipt`)).recordedSources,[])
  await api('remittance.upload',{file:original},409);await api('bank.deposit.upload',{bank_source_id:bankId,file:original},409)
  assert.equal((await api('remittances')).some(r=>r.id===first.id),false)
  await h.assertStorageExcludes(['synthetic-nectar-930','synthetic-nectar-931','synthetic-nectar-932','synthetic-nectar-934','synthetic-nectar-935'])
  console.log('AR-006 cross-source public forms and API journey passed: both orders retain one original payment, sources, audits and safe replay')
}
