// Native CAT-012 forms, same asserted HTTP journey and real local D1. Run through heavy-slot.
import assert from 'node:assert/strict'
import {mkdir,writeFile} from 'node:fs/promises'
import {chromium} from '@playwright/test'
import {harness} from './harness.mjs'
import {prepaidRefundFlow,harnessOptions} from './prepaid-refunds.mjs'
const directory=process.env.NECTAR_EVIDENCE_DIR??'.evidence/refund-intake'
await mkdir(directory,{recursive:true})
const h=await harness({assets:true,...harnessOptions()}),captures=[]
let browser
try{
  assert.equal((await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})).status,303)
  const owner=await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
  await h.api('business.configure',owner,{legal_name:'Alder Research Software',timezone:'UTC',invoice_prefix:'ALDER',payment_terms_days:30})
  browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
  const context=await browser.newContext(),page=await context.newPage()
  const as=async(cookie)=>{await context.clearCookies();await context.addCookies(cookie.split('; ').map(value=>{const i=value.indexOf('=');return {name:value.slice(0,i),value:value.slice(i+1),url:h.origin}}))}
  const open=async(path,cookie)=>{if(cookie)await as(cookie);const r=await page.goto(h.origin+path);assert.equal(r.status(),200)}
  const both=async(label,path,cookie)=>{
    await open(path,cookie)
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:950})
      assert.equal(await page.locator('main h1').count(),1)
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${label} fits ${width}`)
      // All controls on this flow have visible words; any future icon-only
      // control must supply a tooltip with the owner-prescribed interaction.
      const iconOnly=await page.locator('a,button,[role=button]').evaluateAll(nodes=>nodes.filter(n=>!n.textContent.trim()&&n.querySelector('svg,img')).map(n=>n.outerHTML))
      assert.deepEqual(iconOnly,[],`No unlabelled icon controls on ${label}`)
      const file=`${width}-${label}.png`;await page.screenshot({path:`${directory}/${file}`,fullPage:true});captures.push({width,label,file});console.log(`BROWSER ${width} ${label}`)
    }
  }
  const submit=async(form)=>{await Promise.all([page.waitForNavigation({waitUntil:'load'}),form.getByRole('button').click()]);assert.equal(new URL(page.url()).searchParams.get('error'),null)}
  const pending=async(row)=>(await h.api(`prepaid/refunds?subscription=${row.subscription}`,owner)).find(r=>r.status==='pending')
  await prepaidRefundFlow(h,owner,{
    onIntakeState:async({label,row,refund,support,session,finance})=>{
      if(label==='support-request-form')await both(label,`/app/prepaid/${row.subscription}`,support)
      else if(label==='portal-request-form'||label==='portal-pending')await both(label,`/portal/prepaid?session=${encodeURIComponent(session.token)}`)
      else if(label==='support-pending')await both(label,refund.source,support)
      else if(label==='finance-prepared'){
        await both(label,refund.source,finance)
        const form=page.locator('form[action="/app/do/prepaid.refund.decide"]').filter({has:page.locator('input[name=decision][value=approved]')})
        await Promise.all([page.waitForNavigation({waitUntil:'load'}),form.getByRole('button').click()])
        assert.equal(new URL(page.url()).searchParams.get('error'),'second_approver_required')
        for(const width of [1440,390]){await page.setViewportSize({width,height:950});const file=`${width}-finance-self-approval-refused.png`;await page.screenshot({path:`${directory}/${file}`,fullPage:true});captures.push({width,label:'finance-self-approval-refused',file})}
      }else await both(label,'/app/prepaid/refunds',owner)
    },
    requestIntake:async({row,support})=>{
      await open(`/app/prepaid/${row.subscription}`,support)
      await submit(page.locator('form[action="/app/do/prepaid.refund.request"]').filter({has:page.locator(`input[name=grant][value="${row.grant}"]`)}))
      return pending(row)
    },
    requestPortalIntake:async({row,session})=>{
      await open(`/portal/prepaid?session=${encodeURIComponent(session.token)}`)
      await submit(page.locator('form').filter({has:page.locator(`input[name=grant][value="${row.grant}"]`)}))
      return pending(row)
    },
    prepareIntake:async({row,intake})=>{
      await both('owner-review-support-request',`/app/prepaid/refunds/${intake.id}`,owner)
      const form=page.locator('form[action="/app/do/prepaid.refund.prepare"]');await form.locator('[name=reason]').fill('Synthetic unused paid service returned to its original card');await submit(form)
      return pending(row)
    },
    financePrepare:async({row,finance})=>{
      await both('finance-prepare-form',`/app/prepaid/${row.subscription}`,finance)
      const form=page.locator('form[action="/app/do/prepaid.refund.prepare"]').filter({has:page.locator(`input[name=grant][value="${row.grant}"]`)})
      await form.locator('[name=reason]').fill('Synthetic unused paid service returned to its original card');await submit(form)
      return pending(row)
    },
  })
  await writeFile(`${directory}/screens.json`,JSON.stringify({journey:'CAT-012 native refund intake and notices',captures},null,2))
}finally{await browser?.close();await h.close()}
