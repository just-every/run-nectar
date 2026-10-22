// Real customer-session pages over the prepaid public-door business journey.
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { harness } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { portalPrepaidFlow } from './portal-prepaid.mjs'

const directory=process.env.NECTAR_EVIDENCE_DIR??'.evidence/portal-prepaid'
await mkdir(directory,{recursive:true})
const captures=[],tokens=new Set()
const h=await harness({assets:true})
let browser,failure,complete=false
const safe=text=>{
  for(const token of tokens)text=text.replaceAll(token,'[redacted]').replaceAll(encodeURIComponent(token),'[redacted]')
  return text.replace(/session=[^&\s"'<>]+/g,'session=[redacted]')
}
try {
  await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})
  const owner=await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
  await h.api('business.configure',owner,{legal_name:'Alder Research Software',timezone:'UTC',invoice_prefix:'ALDER',payment_terms_days:30})
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Reviewed focused customer portal browser journey'})
  await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
  browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
  // No operator cookies: all browser reads use only the issued customer capability.
  const context=await browser.newContext(),page=await context.newPage()
  page.setDefaultTimeout(15000)
  const navigate=async(path,session)=>{
    const url=new URL(path,h.origin)
    url.searchParams.set('session',session.token)
    const response=await page.goto(url.href)
    assert.equal(response?.status(),200,`Customer page ${path}`)
    assert.equal(new URL(page.url()).pathname,path)
  }
  const click=async(locator,path)=>{
    const [response]=await Promise.all([page.waitForNavigation({waitUntil:'load'}),locator.click()])
    assert.equal(response?.status(),200,`Native customer navigation to ${path}`)
    assert.equal(new URL(page.url()).pathname,path)
  }
  const shot=async(label,language,denomination)=>{
    assert.equal(await page.locator('html').getAttribute('lang'),language)
    assert.ok(await page.locator('main h1').isVisible(),label)
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${label} fits at ${page.viewportSize().width}`)
    assert.equal(await page.locator('a[href^="/app/"]').count(),0,'Customer pages expose no operator navigation')
    assert.doesNotMatch(await page.locator('main').innerText(),/portal\.prepaid\.|untranslated_key|provider_ref|synthetic-nectar-payment-|PRIVATE-|INTERNAL-/)
    const width=page.viewportSize().width,file=`${width}-${language}-${denomination}-${label}.png`
    await page.screenshot({path:`${directory}/${file}`,fullPage:true})
    const url=new URL(page.url())
    url.searchParams.set('session','[redacted]')
    captures.push({label,width,language,denomination,path:safe(url.pathname+url.search),file})
    console.log(`BROWSER ${width} ${language} ${denomination} ${label}`)
  }
  // Assert the visible financial values against the exact public projection,
  // including typed quantities; an amount of units is never formatted as USD.
  const lotCard=async(lot,language)=>{
    const card=page.locator('section.card').filter({has:page.locator(`a[href^="${lot.href}?"]`)})
    assert.equal(await card.count(),1)
    const locale=language==='en'?'en-US':language,plain=text=>text.replace(/[\u00a0\u202f]/g,' ')
    const money=cents=>plain(new Intl.NumberFormat(locale,{style:'currency',currency:'USD',currencyDisplay:'code'}).format(cents/100))
    const quantity=(n,text)=>lot.kind==='money'?money(n):`${plain(new Intl.NumberFormat(locale,{maximumFractionDigits:6}).format(Number(text)))} ${lot.unitLabel}`
    const values=await card.locator('dd').allTextContents()
    assert.equal(values[0],quantity(lot.remainingN,lot.remainingQuantity))
    assert.equal(values[1],quantity(lot.availableN,lot.availableQuantity))
    assert.equal(values[2],money(lot.liabilityCents))
    if(lot.meterCode)assert.ok((await card.innerText()).includes(lot.meterCode))
    if(lot.purchaseInvoice)assert.ok((await card.innerText()).includes(lot.purchaseInvoice.number))
  }
  await portalPrepaidFlow(h,owner,{onState:async({row,units,moneySession,unitSession,money,unitData})=>{
    tokens.add(moneySession.token);tokens.add(unitSession.token)
    for(const scenario of [
      {denomination:'money',customer:row.customer,session:moneySession,data:money},
      {denomination:'units',customer:units.customer,session:unitSession,data:unitData},
    ]) {
      const original=await h.api(`customers/${scenario.customer}`,owner)
      const language=async value=>{
        const customer=await h.api(`customers/${scenario.customer}`,owner)
        if(customer.language===value)return
        await h.api('customer.update',owner,{customer:customer.id,revision:customer.revision,name:customer.name,billing_email:customer.billing_email,address:customer.address,language:value})
      }
      assert.ok(scenario.data.lots.length,'The customer has actual retained prepaid sources')
      try {
        for(const locale of ['en','es-US']) {
          await language(locale)
          for(const width of [1440,390]) {
            await page.setViewportSize({width,height:950})
            await navigate('/portal',scenario.session)
            await shot('portal-home',locale,scenario.denomination)
            await click(page.locator('a[href^="/portal/prepaid?"]').first(),'/portal/prepaid')
            for(const lot of scenario.data.lots)await lotCard(lot,locale)
            await shot('prepaid-home',locale,scenario.denomination)
            for(const [index,lot]of scenario.data.lots.entries()) {
              if(index)await navigate('/portal/prepaid',scenario.session)
              await click(page.locator(`a[href^="${lot.href}?"]`),lot.href)
              await lotCard(lot,locale)
              assert.equal(await page.locator('section.card').count(),1+lot.entries.length,'Every retained ledger event is visible')
              await shot(`source-${index+1}`,locale,scenario.denomination)
            }
          }
        }
      } finally {await language(original.language)}
    }
  }})
  complete=true
} catch(error) {
  failure=new Error(safe(error instanceof Error?error.stack??error.message:String(error)))
} finally {
  await writeFile(`${directory}/screens.json`,JSON.stringify({kind:'portal-prepaid',complete,captures},null,2)+'\n')
  await browser?.close()
  await h.close()
}
if(failure)throw failure
