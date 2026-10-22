// Native finance approval and read-only recovery over the real Worker/D1 flow.
// Only the original Stripe capture/refund network edge is synthetic.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { harness } from './harness.mjs'
import { prepaidRefundFlow, harnessOptions } from './prepaid-refunds.mjs'

const directory=process.env.NECTAR_EVIDENCE_DIR??'.evidence/prepaid-refunds'
await mkdir(directory,{recursive:true})
const h=await harness({assets:true,...harnessOptions()}),captures=[]
let browser
try {
  assert.equal((await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})).status,303)
  const owner=await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
  await h.api('business.configure',owner,{legal_name:'Alder Research Software',timezone:'UTC',invoice_prefix:'ALDER',payment_terms_days:30})
  browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
  // The independent finance navigation may wait at Stripe while the owner
  // inspects the reserved ledger in a separate ordinary signed-in context.
  const ownerContext=await browser.newContext(),financeContext=await browser.newContext()
  const operator=await ownerContext.newPage(),financePage=await financeContext.newPage()
  const asActor=async(context,cookie)=>{
    await context.clearCookies()
    await context.addCookies(cookie.split('; ').map(value=>{const i=value.indexOf('=');return {name:value.slice(0,i),value:value.slice(i+1),url:h.origin}}))
  }
  await asActor(ownerContext,owner)
  const visit=async(page,path)=>{
    const response=await page.goto(h.origin+path)
    assert.equal(response.status(),200,'The native public page is available')
    assert.match(response.headers()['content-type'],/text\/html/)
  }
  const both=async(page,label,path,prepare)=>{
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:950})
      if(path)await visit(page,path)
      if(prepare)await prepare()
      assert.equal(await page.locator('main h1').count(),1)
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${label} fits ${width}`)
      const file=`${width}-${label}.png`
      await page.screenshot({path:`${directory}/${file}`,fullPage:true})
      const url=new URL(page.url())
      captures.push({label,width,path:url.pathname+url.search,file})
      console.log(`BROWSER ${width} ${label}`)
    }
  }
  const submit=async(page,form)=>{
    await Promise.all([page.waitForNavigation({waitUntil:'load'}),form.getByRole('button').click()])
    assert.equal(new URL(page.url()).searchParams.get('error'),null,'The native decision succeeds')
    assert.equal(await page.locator('main h1').count(),1)
  }
  const card=(page,refund)=>page.locator(`article[id="refund-${refund.id}"]`)
  const readRefund=async(row,refund,actor=owner)=>{
    const saved=(await h.api(`prepaid/refunds?subscription=${row.subscription}`,actor)).find(value=>value.id===refund.id)
    assert.ok(saved,'The action refers to the same durable refund')
    return saved
  }
  const openEvidence=async(page,refund)=>{
    const disclosure=card(page,refund).locator('details')
    if(await disclosure.getAttribute('open')===null)await disclosure.locator('summary').click()
    const quote=JSON.parse(await disclosure.locator('dd code').first().textContent())
    assert.deepEqual(quote,refund.quote,'The rendered review preserves the exact original capture and unused value')
  }
  await prepaidRefundFlow(h,owner,{
    approveRefund:async({row,refund,finance})=>{
      await asActor(financeContext,finance)
      await visit(financePage,refund.source)
      const approve=card(financePage,refund).locator('form[action="/app/do/prepaid.refund.decide"]').filter({has:financePage.locator('input[name="decision"][value="approved"]')})
      assert.equal(await approve.locator('input[name="refund"]').inputValue(),refund.id)
      assert.equal(await approve.locator('input[name="basis_hash"]').inputValue(),refund.basis)
      assert.equal(await approve.locator('input[name="confirm_single"]').count(),0)
      await both(financePage,`finance-${row.n}-exact-refund-approval`,null,()=>openEvidence(financePage,refund))
      await submit(financePage,approve)
      const saved=await readRefund(row,refund,finance)
      assert.ok(['refunded','uncertain'].includes(saved.status))
      await both(financePage,`finance-${row.n}-${saved.status}`)
      return saved
    },
    reconcileRefund:async({row,refund,expectedStatus})=>{
      await visit(operator,refund.source)
      const reconcile=card(operator,refund).locator('form[action="/app/do/prepaid.refund.reconcile"]')
      assert.equal(await reconcile.locator('input[name="refund"]').inputValue(),refund.id)
      await both(operator,`owner-${row.n}-check-existing-${expectedStatus}`)
      await submit(operator,reconcile)
      const saved=await readRefund(row,refund)
      assert.equal(saved.status,expectedStatus)
      if(expectedStatus==='refunded')assert.equal(await card(operator,refund).locator('form').count(),0,'Recovered refunds offer no second refund attempt')
      await both(operator,`owner-${row.n}-checked-${expectedStatus}`)
      return saved
    },
    onState:async({label,rows,refund})=>{
      const row=rows.find(row=>row.subscription===refund.quote.subscription)
      assert.ok(row)
      await both(operator,`owner-${row.n}-${label}-ledger`,`/app/prepaid/${row.subscription}`)
      await both(operator,`owner-${row.n}-${label}-refund-source`,refund.source,()=>openEvidence(operator,refund))
      if(label==='prepared'){
        await both(operator,'owner-original-paid-purchase',`/app/invoices/${row.invoice}`)
        const grant=row.before.entries.find(entry=>entry.kind==='grant')
        assert.ok(grant?.href)
        await both(operator,'owner-original-paid-grant',grant.href)
      }
      if(['refunded','reconciled'].includes(label)){
        const state=await h.api(`prepaid/${row.subscription}`,owner),entry=state.entries.find(entry=>entry.kind==='refund')
        assert.ok(entry?.href)
        await both(operator,`owner-${row.n}-liability-reversal-source`,entry.href)
        await both(operator,`owner-${row.n}-unchanged-original-purchase`,`/app/invoices/${row.invoice}`)
        const query=`?period=2026-11&customer=${row.customer}`
        const report=await h.api(`reports/refunds${query}`,owner),contribution=report.entries.find(entry=>entry.sourceReference===refund.id)
        assert.ok(contribution?.href)
        await both(operator,`owner-${row.n}-cash-refund-report`,`/app/reports/refunds${query}`)
        assert.ok(await operator.locator(`a[href="${contribution.href}"]`).count(),'Cash totals link to their refund source')
        await both(operator,`owner-${row.n}-cash-refund-report-source`,contribution.href)
        assert.equal(await operator.locator('#refund-evidence').count(),1)
        await both(operator,`owner-${row.n}-remaining-credit-report`,`/app/reports/credit-balances?customer=${row.customer}`)
        await both(operator,`owner-${row.n}-unchanged-revenue`,`/app/revenue?period=2026-11&customer=${row.customer}`)
        await both(operator,`owner-${row.n}-purchase-revenue-source`,`/app/revenue/${row.invoice}?period=2026-11`)
      }
    },
  })
  await writeFile(`${directory}/screens.json`,JSON.stringify({journey:'unused-paid-prepaid-refund',captures},null,2))
} catch(error) {
  console.error(String(error?.stack??error))
  process.exitCode=1
} finally {await browser?.close();await h.close()}
