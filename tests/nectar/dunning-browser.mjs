import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { harness } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { dunningSequenceFlow,harnessOptions } from './dunning-sequences.mjs'
import { dunningCustodyFlow,harnessOptions as custodyOptions } from './dunning-custody.mjs'
if(process.env.NECTAR_JOURNEY_RUN)console.log(`JOURNEY RUN ${process.env.NECTAR_JOURNEY_RUN} HEAD ${execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()}`)
const custody=process.argv.includes('custody'),directory=process.env.NECTAR_EVIDENCE_DIR??'.evidence/dunning'
await mkdir(directory,{recursive:true})
const h=await harness(custody?custodyOptions():harnessOptions());let browser
try {
 await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})
 const owner=await h.signIn(h.vars.OWNER_EMAIL)
 await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
 await h.api('business.configure',owner,{legal_name:'Cedar Software Inc',timezone:'UTC',invoice_prefix:'DUN',payment_terms_days:30})
 await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Reviewed dunning journey'})
 await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
 browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
 const context=await browser.newContext(),customerContext=await browser.newContext()
 await context.addCookies(owner.split('; ').map(part=>{const i=part.indexOf('=');return {name:part.slice(0,i),value:part.slice(i+1),url:h.origin}}))
 const page=await context.newPage(),customer=await customerContext.newPage(),email=await (await browser.newContext()).newPage(),seen=new Set()
 const shot=async(target,label)=>{
  if(seen.has(label))return;seen.add(label)
  for(const width of [1440,390]){
   await target.setViewportSize({width,height:1000})
   assert.equal(await target.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${label} fits ${width}`)
   const iconOnly=target.locator('a,button,[role=button]').filter({has:target.locator('svg,img')})
   const missing=await iconOnly.evaluateAll(nodes=>nodes.filter(n=>!n.textContent.trim()&&!n.getAttribute('aria-describedby')).map(n=>n.outerHTML))
   assert.deepEqual(missing,[],'Every icon-only control has a descriptive tooltip')
   await target.screenshot({path:`${directory}/${width}-${label}.png`,fullPage:true})
   const section=target.locator('#dunning-sequence,#automatic-collection').first()
   if(await section.count())await section.screenshot({path:`${directory}/${width}-${label}-detail.png`})
   console.log('BROWSER',width,label)
  }
 }
 const postForm=async(action,input,{path='/app/settings/dunning',label=action,scope}={})=>{
  await page.goto(h.origin+path)
  const details=page.locator('#dunning-policy');if(await details.count())await details.locator('summary').click()
  const form=(scope?page.locator(scope):page).locator(`form[action="/app/do/${action}"]`).first()
  for(const [name,value] of Object.entries(input)){
   const field=form.locator(`[name="${name}"]`)
   if(await field.count()===0)continue
   const type=await field.getAttribute('type')
   if(type==='hidden'){assert.equal(await field.inputValue(),String(value));continue}
   if(type==='checkbox'){if(value)await field.check();else await field.uncheck()}
   else if(await field.evaluate(n=>n.tagName)==='SELECT')await field.selectOption(String(value))
   else await field.fill(String(value))
  }
  await shot(page,label)
  await Promise.all([page.waitForNavigation(),form.getByRole('button').click()])
  assert.equal(new URL(page.url()).searchParams.has('error'),false,`Native ${action} completed`)
 }
 const onState=async state=>{
  const id=state.record?.series?.id??state.record?.series??state.records?.[0]?.series?.id
  await page.goto(h.origin+'/app/settings/dunning'+(id?`?series=${id}`:''))
  if(['enrolled','complete'].includes(state.state))await page.locator('#dunning-policy > summary').click()
  await shot(page,`${custody?'custody-':''}${state.state}${state.message?`-${state.record.series.id.slice(0,6)}-${state.message.step}`:''}`)
  if(state.emailHtml){
   await email.goto('about:blank');await email.setContent(state.emailHtml)
   const language=await email.locator('html').getAttribute('lang')
   await shot(email,`email-${language}-${state.link?'update':'invoice'}`)
   if(state.link){
    const link=email.getByRole('link');assert.ok((await link.boundingBox()).height>=44,'The actual message update button is tappable on a phone')
    await Promise.all([email.waitForNavigation(),link.click()])
    assert.equal(new URL(email.url()).pathname,'/portal/payment-methods')
   }
  }
  if(state.link){await customer.goto(state.link);await shot(customer,`customer-link-${state.record===state.records?.[0]?'recovery':state.record.customer.slice(0,6)}-${state.message.step}`)}
  if(state.state==='recovered'||state.state==='restricted'||state.state==='restored'){
   await page.goto(h.origin+`/app/invoices/${state.record.invoice}`);await shot(page,`invoice-${state.state}`)
   await page.goto(h.origin+'/app/reports/recovery');await shot(page,`report-${state.state}`)
  }
 }
 if(custody)await dunningCustodyFlow(h,owner,{onState})
 else await dunningSequenceFlow(h,owner,{
  onState,
  createPolicy:async input=>{
   await postForm('dunning.policy.create',input,{label:`policy-${input.scope}`})
   return (await h.api('dunning',owner)).policies.find(p=>p.name===input.name)
  },
  enroll:async input=>{
   await postForm('dunning.enroll',input,{label:'invoice-enrollment'})
   return (await h.api('dunning',owner)).series.find(s=>s.invoice_id===input.invoice)
  },
  prepareMail:async input=>{
   await postForm('dunning.mail.prepare',input,{path:`/app/settings/dunning?series=${input.series}`,label:`prepare-message-${input.step}`})
   const row=(await h.api('dunning',owner)).series.find(s=>s.id===input.series).deliveries.find(d=>d.step===input.step)
   return {...row,basisHash:row.basis_hash,due:row.due_date}
  },
  sendMail:async input=>{
   const series=(await h.api('dunning',owner)).series.find(s=>s.deliveries.some(d=>d.id===input.delivery))
   await postForm('dunning.mail.send',input,{path:`/app/settings/dunning?series=${series.id}`,scope:`[data-dunning-delivery="${input.delivery}"]`,label:`confirm-send-${series.id.slice(0,6)}-${input.delivery.slice(0,6)}`})
   return (await h.api('dunning',owner)).series.find(s=>s.id===series.id).deliveries.find(d=>d.id===input.delivery)
  },
  finish:async input=>{
   await postForm('dunning.end',input,{path:`/app/settings/dunning?series=${input.series}`,label:`final-${input.action}`})
  },
  updateMethod:async({path,setupId,complete})=>{
   await customer.goto(h.origin+path);await shot(customer,'customer-update-consent')
   const consent=customer.locator(`form:has(input[name="setup"][value="${setupId}"])`)
   await consent.locator('[name=confirm]').check();await consent.locator('[name=make_default]').check()
   await customer.route('https://checkout.stripe.com/**',route=>route.abort())
   await Promise.all([customer.waitForRequest(request=>request.url().startsWith('https://checkout.stripe.com/')),consent.getByRole('button').click()])
   complete()
   await customer.goto(h.origin+path);await shot(customer,'customer-update-open')
   const finish=customer.locator(`form:has(input[name="setup"][value="${setupId}"])`)
   await finish.locator('[name=confirm]').check()
   await Promise.all([customer.waitForNavigation(),finish.getByRole('button').first().click()])
   await shot(customer,'customer-update-complete')
  },
  cancelSubscription:async input=>{
   await postForm('subscription.cancel',input,{path:`/app/subscriptions/${input.subscription}`,label:'review-cancellation'})
  },
  prepareRecovery:async input=>{
   const collection=(await h.api('automatic-collections',owner)).find(r=>r.id===input.request)
   await page.goto(h.origin+`/app/invoices/${collection.invoice}`)
   const details=page.locator('#automatic-collection details').filter({has:page.getByText('Recover with a new card',{exact:true})});await details.locator('summary').click()
   const form=details.locator('form');await form.locator('[name=dunning_delivery]').selectOption(input.dunning_delivery);await form.locator('[name=confirm]').check()
   await shot(page,'invoice-exact-message-recovery')
   await Promise.all([page.waitForNavigation(),form.getByRole('button').click()])
   assert.equal(new URL(page.url()).searchParams.has('error'),false)
   return (await h.api('automatic-collections',owner)).find(r=>r.id===input.request).recoveries.at(-1)
  }
 })
 await page.goto(h.origin+'/app/settings');await shot(page,'settings-entry')
} finally {await browser?.close();await h.close()}
