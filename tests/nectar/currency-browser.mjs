// CAT-008: native source, rate-entry and collection forms over the asserted Worker flow.
import assert from 'node:assert/strict'
import {mkdir,writeFile} from 'node:fs/promises'
import {chromium} from '@playwright/test'
import {harness} from './harness.mjs'
import {currencyFlow,harnessOptions} from './currency.mjs'
const directory=process.env.NECTAR_EVIDENCE_DIR??'.evidence/currency'
await mkdir(directory,{recursive:true})
const h=await harness({assets:true,...harnessOptions()}),captures=[]
let browser
try{
  await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})
  const owner=await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
  await h.api('business.configure',owner,{legal_name:'Alder Research Software',timezone:'UTC',invoice_prefix:'ALDER',payment_terms_days:30})
  browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
  const context=await browser.newContext(),page=await context.newPage()
  await context.addCookies(owner.split('; ').map(value=>{const i=value.indexOf('=');return {name:value.slice(0,i),value:value.slice(i+1),url:h.origin}}))
  const both=async(label,path)=>{
    assert.equal((await page.goto(h.origin+path)).status(),200)
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:950})
      assert.equal(await page.locator('main h1').count(),1)
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${label} fits ${width}`)
      const iconOnly=await page.locator('a,button,[role=button]').evaluateAll(nodes=>nodes.filter(n=>!n.textContent.trim()&&n.querySelector('svg,img')).map(n=>n.outerHTML));assert.deepEqual(iconOnly,[])
      const file=`${width}-${label}.png`;await page.screenshot({path:`${directory}/${file}`,fullPage:true});captures.push({width,label,file});console.log('BROWSER',width,label)
    }
  }
  const submit=async(form)=>{await Promise.all([page.waitForNavigation({waitUntil:'load'}),form.getByRole('button').click()]);assert.equal(new URL(page.url()).searchParams.get('error'),null)}
  await currencyFlow(h,owner,{
    recordRate:async(payload)=>{
      await page.goto(h.origin+'/app/reports/currency?from=2026-10-01&to=2026-10-23')
      const form=page.locator('form[action="/app/do/currency.rate.record"]')
      await form.locator('[name=currency]').selectOption(payload.currency)
      for(const key of ['rate_date','usd_per_unit','source'])await form.locator(`[name=${key}]`).fill(payload[key])
      await submit(form)
    },
    confirmCollection:async({invoice,prepared})=>{
      await page.goto(h.origin+`/app/invoices/${invoice}`)
      const form=page.locator('form[action="/app/do/collection.confirm"]');assert.equal(await form.locator('[name=request]').inputValue(),prepared.id)
      await form.locator('[name=confirm]').check();await submit(form)
      return (await h.api('native-collections',owner)).find(r=>r.id===prepared.id)
    },
    onState:async({stage,customer,invoice,run})=>{
      if(stage==='missing-rate'){
        await both('cad-catalog-books','/app/catalog')
        await both('cad-missing-daily-rate','/app/reports/currency?from=2026-10-01&to=2026-10-23')
        await both('cad-bill-run',`/app/billing/${run}`)
      }else if(stage==='review')await both('cad-exact-card-review',`/app/invoices/${invoice}`)
      else{
        await both('cad-collected-invoice',`/app/invoices/${invoice}`)
        await both('cad-customer-record',`/app/customers/${customer}`)
        await both('cad-usd-sourced-report','/app/reports/currency?from=2026-10-01&to=2026-10-23')
        await h.api('portal.configure',owner,{hosts:[h.origin],parents:[]})
        const session=await h.api('portal.session.issue',owner,{customer,origin:h.origin,audience:'hosted'})
        const path=`/portal/invoices/${invoice}?session=${encodeURIComponent(session.token)}`
        await both('cad-customer-invoice',path)
        assert.ok((await page.locator('main').textContent()).includes('CAD'))
      }
    },
  })
  await writeFile(`${directory}/screens.json`,JSON.stringify({journey:'CAT-008 current currency doors',captures},null,2))
}finally{await browser?.close();await h.close()}
