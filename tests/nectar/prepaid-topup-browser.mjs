// Real portal consent and independent native approval over prepaidTopupFlow.
// The application is the built Worker/D1; only Stripe's network edge is fake.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { harness } from './harness.mjs'
import { prepaidTopupFlow, harnessOptions } from './prepaid-topup.mjs'

const directory=process.env.NECTAR_EVIDENCE_DIR??'.evidence/prepaid-topup'
await mkdir(directory,{recursive:true})
const h=await harness({assets:true,...harnessOptions()}),captures=[]
let browser
const safePath=value=>{
  const url=new URL(value)
  for(const name of [...url.searchParams.keys()])if(/session|token|secret|code|key/i.test(name))url.searchParams.set(name,'[redacted]')
  return url.pathname+url.search
}
try {
  assert.equal((await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})).status,303)
  const owner=await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
  await h.api('business.configure',owner,{legal_name:'Alder Research Software',timezone:'UTC',invoice_prefix:'ALDER',payment_terms_days:30})
  browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
  const operatorContext=await browser.newContext(),customerContext=await browser.newContext()
  const operator=await operatorContext.newPage(),customer=await customerContext.newPage()
  const asActor=async cookie=>{
    await operatorContext.clearCookies()
    await operatorContext.addCookies(cookie.split('; ').map(value=>{const i=value.indexOf('=');return {name:value.slice(0,i),value:value.slice(i+1),url:h.origin}}))
  }
  await asActor(owner)
  const visit=async(page,path)=>{
    const response=await page.goto(h.origin+path)
    assert.equal(response.status(),200,'The native public page is available')
    assert.match(response.headers()['content-type'],/text\/html/,'The customer opens the HTML quote, not its JSON representation')
  }
  const both=async(page,label,path,prepare)=>{
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:950})
      if(path)await visit(page,path)
      if(prepare)await prepare()
      assert.ok(await page.locator('main h1').count(),`${label} has its public heading`)
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${label} fits ${width}`)
      const file=`${width}-${label}.png`
      await page.screenshot({path:`${directory}/${file}`,fullPage:true})
      captures.push({label,width,path:safePath(page.url()),file})
      console.log(`BROWSER ${width} ${label}`)
    }
  }
  const submit=async(page,form)=>{
    await Promise.all([page.waitForNavigation({waitUntil:'load'}),form.getByRole('button').click()])
    assert.equal(new URL(page.url()).searchParams.get('error'),null,'The exact native decision succeeds')
    assert.equal(await page.locator('main h1').count(),1)
  }
  const portalPath=(row,session)=>`/portal/prepaid-topups/${row.authorization.id}?session=${encodeURIComponent(session.token)}`
  const portalQuote=async(row,session)=>{
    const response=await h.raw(portalPath(row,session))
    assert.equal(response.status,200)
    return response.json()
  }
  const representative=row=>[1,3].includes(row.n)
  await prepaidTopupFlow(h,owner,{
    acceptAuthorization:async({row,session})=>{
      await visit(customer,portalPath(row,session))
      const accept=customer.locator('form').filter({has:customer.locator('input[name="accept"]')})
      assert.equal(await accept.count(),1)
      assert.equal(await accept.locator('input[name="basis_hash"]').inputValue(),row.authorization.basis)
      assert.equal(await accept.locator('input[name="authorization"]').inputValue(),row.authorization.id)
      assert.equal(await accept.locator('input[name="accept"]').isChecked(),false,'Consent starts unchecked')
      if(representative(row))await both(customer,`customer-${row.n}-quote-awaiting`)
      await accept.locator('input[name="accept"]').check()
      if(representative(row))await both(customer,`customer-${row.n}-explicit-consent`)
      await submit(customer,accept)
      const accepted=await portalQuote(row,session)
      assert.equal(accepted.status,'pending')
      assert.equal(accepted.basis,row.authorization.basis)
      assert.equal(await customer.locator('input[name="accept"]').count(),0,'An accepted quote cannot be accepted again')
      if(representative(row))await both(customer,`customer-${row.n}-accepted`)
    },
    approveAuthorization:async({row,finance})=>{
      await asActor(finance)
      try {
        await visit(operator,`/app/prepaid/${row.subscription}`)
        const card=operator.locator(`article[id="topup-${row.authorization.id}"]`)
        const approve=card.locator('form[action="/app/do/prepaid.topup.decide"]').filter({has:operator.locator('input[name="decision"][value="approved"]')})
        assert.equal(await approve.locator('input[name="basis_hash"]').inputValue(),row.authorization.basis)
        assert.equal(await approve.locator('input[name="confirm_single"]').count(),0,'Finance approves independently of the owner who prepared the quote')
        if(representative(row))await both(operator,`finance-${row.n}-exact-approval`,null,async()=>{
          const details=card.locator('details')
          if(await details.getAttribute('open')===null)await details.locator('summary').click()
        })
        await submit(operator,approve)
        const approved=(await h.api(`prepaid/topup-authorizations?subscription=${row.subscription}`,finance)).find(value=>value.id===row.authorization.id)
        assert.equal(approved.status,'active')
        assert.equal(approved.acceptance.basis,row.authorization.basis)
        if(representative(row))await both(operator,`finance-${row.n}-active-policy`)
      } finally {await asActor(owner)}
    },
    revokeAuthorization:async({row,session})=>{
      await visit(customer,portalPath(row,session))
      assert.equal((await portalQuote(row,session)).status,'active')
      await both(customer,'customer-active-before-revocation')
      const revoke=customer.locator('form[action^="/portal/prepaid-topup.revoke?"]')
      assert.equal(await revoke.locator('input[name="authorization"]').inputValue(),row.authorization.id)
      await submit(customer,revoke)
      assert.equal((await portalQuote(row,session)).status,'revoked')
      assert.equal(await customer.locator('form').count(),0,'Revoked authorization offers neither accept nor revoke again')
      await both(customer,'customer-revoked-quote')
    },
    onState:async state=>{
      await asActor(owner)
      if(state.label==='active'){
        if(representative(state.row)){
          await both(customer,`customer-${state.row.n}-active-quote`,portalPath(state.row,state.session))
          await both(operator,`owner-${state.row.n}-authorization-source`,`/app/prepaid/topup-authorizations/${state.row.authorization.id}`)
        }
        return
      }
      if(state.row){
        await both(operator,`owner-${state.label}-ledger`,`/app/prepaid/${state.row.subscription}`)
        await both(operator,`owner-${state.label}-source`,`/app/prepaid/topup-authorizations/${state.row.authorization.id}`)
      }
      if(state.claim?.invoice_id){
        await both(operator,`owner-${state.label}-purchase-invoice`,`/app/invoices/${state.claim.invoice_id}`)
        const sourceRow=state.row??state.rows.find(row=>row.subscription===state.claim.subscription_id)
        assert.ok(sourceRow,'The purchase belongs to its exact subscription')
        const ledger=await h.api(`prepaid/${sourceRow.subscription}`,owner)
        const lot=ledger.grants.find(grant=>grant.purchaseInvoice===state.claim.invoice_id)
        const entry=ledger.entries.find(entry=>entry.kind==='grant'&&entry.grantId===lot?.id)
        if(entry)await both(operator,`owner-${state.label}-grant-source`,`/app/prepaid/${sourceRow.subscription}/entries/${encodeURIComponent(entry.id)}`)
      }
      if(state.label==='uncertain'){
        const form=operator.locator('form[action="/app/do/prepaid.topup.reconcile"]').filter({has:operator.locator(`input[name="claim"][value="${state.claim.id}"]`)})
        await visit(operator,`/app/prepaid/${state.row.subscription}`)
        await both(operator,'owner-uncertain-reconciliation')
        await submit(operator,form)
        assert.equal((await h.api(`prepaid/topup-claims?subscription=${state.row.subscription}`,owner)).find(claim=>claim.id===state.claim.id).status,'uncertain')
        await both(operator,'owner-reconciled-still-uncertain')
      }
      if(state.label==='refusals'){
        for(const row of state.rows.slice(1,4))await both(operator,`owner-${row.n}-refused-policy`,`/app/prepaid/${row.subscription}`)
      }
    },
  })
  await writeFile(`${directory}/screens.json`,JSON.stringify({journey:'customer-authorized-prepaid-topup',captures},null,2))
} catch(error) {
  console.error(String(error?.stack??error).replace(/([?&]session=)[^&\s"'<>]+/g,'$1[redacted]'))
  process.exitCode=1
} finally {await browser?.close();await h.close()}
