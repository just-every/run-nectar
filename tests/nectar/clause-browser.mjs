import { moveInvestigationsFlow } from './move-investigations.mjs'
import { transferInstructionsFlow,harnessOptions as transferOptions } from './transfer-instructions.mjs'
import { reconciliationFlow } from './reconciliation.mjs'
import { commitments } from './commitments.mjs'
import { seedPortalRecords } from './portal-sessions.mjs'
import { portalCorrections } from './portal-corrections.mjs'
import { entitlementQuotasFlow } from './entitlement-quotas.mjs'
import { portalAnswersFlow } from './portal-answers.mjs'
import { prepaidBrowser } from './prepaid-browser.mjs'
import { nativeCollectionFlow,harnessOptions as nativeOptions } from './native-collection.mjs'
// Focused real-browser use of a clause's own public pages and native forms.
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { harness } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { erasureFlow } from './erasure.mjs'
import { moveCollectionFlow,harnessOptions as collectionOptions } from './move-collection.mjs'
import { moveHistoryFlow } from './move-history.mjs'
import { intervalsFlow } from './intervals.mjs'
import { contractEntitySetup } from './contract-setup.mjs'
import { intervalCancellationFlow } from './interval-cancel.mjs'
import { numberingEntitiesFlow } from './numbering-entities.mjs'
const kind=process.argv[2],directory=process.env.NECTAR_EVIDENCE_DIR??`.evidence/${kind}`
assert.ok(['move-investigations','transfer-instructions','assurance','entitlements','portal-usage','erasure','history','collection','numbering','intervals','cancellation','entity-setup','prepaid','native-collection'].includes(kind))
await mkdir(directory,{recursive:true})
const captures=[]
const h=await harness({assets:true,...(kind==='transfer-instructions'?transferOptions():kind==='collection'?collectionOptions():kind==='native-collection'?nativeOptions():{})});let browser
try {
  await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})
  const owner=await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
  await h.api('business.configure',owner,{legal_name:'Alder Research Software',timezone:'UTC',invoice_prefix:'ALDER',payment_terms_days:30})
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Reviewed focused browser journey'})
  await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{}),args:['--use-mock-keychain','--password-store=basic','--no-sandbox']})
  const context=await browser.newContext()
  await context.addCookies(owner.split('; ').map(value=>{const i=value.indexOf('=');return {name:value.slice(0,i),value:value.slice(i+1),url:h.origin}}))
  const page=await context.newPage()
  const shot=async(label,path)=>{
    if(path)await page.goto(h.origin+path)
    assert.ok(await page.locator('main h1').count(),label)
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${label} fits at ${page.viewportSize().width}`)
    await page.screenshot({path:`${directory}/${page.viewportSize().width}-${label}.png`,fullPage:true})
    captures.push({label,width:page.viewportSize().width,path:new URL(page.url()).pathname+new URL(page.url()).search.replace(/session=[^&]+/g,'session=[redacted]'),file:`${page.viewportSize().width}-${label}.png`})
    console.log(`BROWSER ${page.viewportSize().width} ${label}`)
  }
  const both = async (label,path,prepare) => {
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:950})
      if(path)await page.goto(h.origin+path)
      if(prepare)await prepare()
      await shot(label)
    }
  }
  const form = action => page.locator(`form[action="/app/do/${action}"]`)
  const submit = async locator => {
    await Promise.all([page.waitForNavigation({waitUntil:'load'}),locator.getByRole('button').first().click()])
    const url=new URL(page.url())
    assert.equal(url.searchParams.get('error'),null,`Native form submission ${url.pathname}: ${url.searchParams.get('error')}`)
  }
  if(kind==='move-investigations') {
    await moveInvestigationsFlow(h,owner,{onState:async state=>{
      await page.setViewportSize({width:1440,height:950})
      await page.goto(h.origin+state.path)
      assert.equal(await page.locator('[data-move-case]').count(),3)
      if(state.label==='three-differences') {
        assert.match(await page.locator('main').innerText(),/Quantity/)
        assert.match(await page.locator('main').innerText(),/Unit price/)
        assert.match(await page.locator('main').innerText(),/Service ends/)
        await submit(form('move.investigate'))
        assert.equal(await page.locator('[data-move-case]').count(),3,'native repeated investigation keeps three cases')
      } else {
        assert.equal(await form('assurance.approve').count(),0,'resolved cases need no further confirmation')
        await submit(form('assurance.recheck').first())
        assert.match(await page.locator('[data-move-case]').first().innerText(),/resolved/)
      }
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
      assert.equal(await page.locator('main button').evaluateAll(nodes=>nodes.filter(node=>!node.textContent.trim()).length),0)
      for(const width of [1440,390]) {
        await page.setViewportSize({width,height:950})
        await page.screenshot({path:`${directory}/${width}-${state.label}.png`,fullPage:true})
        captures.push({label:state.label,width,file:`${width}-${state.label}.png`})
        console.log(`BROWSER ${width} ${state.label}`)
      }
    }})
  }
  else if(kind==='transfer-instructions')await transferInstructionsFlow(h,owner,{onState:async state=>{
    await both(state.label,state.path,async()=>{
      if(page.viewportSize().width===1440){
        const section=page.locator('section[aria-label]').first()
        for(const value of [state.fields.bankName,state.fields.accountHolderName,state.fields.accountNumber,state.fields.routingNumber])assert.ok((await section.innerText()).includes(value))
        const small=await page.locator('main *').evaluateAll(nodes=>nodes.filter(n=>n.textContent.trim()&&getComputedStyle(n).display!=='none'&&Number.parseFloat(getComputedStyle(n).fontSize)<13).map(n=>n.tagName))
        assert.deepEqual(small,[],'Customer instruction text is at least 13px')
        assert.equal(await page.locator('button:has(svg),a:has(svg)').count(),0,'Every customer control has a visible label')
      }
    })
  }})
  else if(kind==='assurance') {
    await reconciliationFlow(h,owner,async state=>{
      await both(`assurance-${state.label}`,state.path,async()=>{
        if(state.label==='assignee-demoted') {
          const approve=page.locator('form[action="/app/do/proposal.decide"]').filter({has:page.locator('input[name="decision"][value="approved"]')})
          await Promise.all([page.waitForNavigation({waitUntil:'load'}),approve.getByRole('button',{name:'Approve',exact:true}).click()])
          assert.equal(new URL(page.url()).searchParams.get('error'),'assurance_owner_unavailable')
          assert.match(await page.locator('[role="alert"]').innerText(),/assurance owner unavailable/)
        }
        const iconOnly=await page.locator('button,a,[role="button"]').evaluateAll(nodes=>nodes.filter(n=>getComputedStyle(n).display!=='none'&&!n.textContent.trim()&&n.querySelector('svg,img')).map(n=>n.getAttribute('aria-label')||n.getAttribute('title')||''))
        assert.deepEqual(iconOnly,[],'proposal screens contain no icon-only controls requiring a tooltip')
      })
    })
  }
  else if(kind==='entitlements') {
    await entitlementQuotasFlow(h,owner,{onState:async state=>{
      if(!state.label?.startsWith('numeric-'))return
      await both(state.label,`/app/customers/${state.customer}#ents`,async()=>{
        await page.reload()
        const section=page.locator('section[aria-labelledby="ents"]')
        const text=await section.innerText()
        assert.ok(text.includes(state.allowed ? `Numeric limit: ${state.limit}.` : 'Denied'),'The rendered entitlement matches the current API decision')
        await section.scrollIntoViewIfNeeded()
        await page.screenshot({path:`${directory}/${page.viewportSize().width}-${state.label}-detail.png`})
      })
      if(state.label==='numeric-approved')await both('numeric-policy','/app/catalog',async()=>{
        const policy=form('feature.policy').filter({has:page.locator(`input[name="product"][value="${state.product}"]`)})
        assert.equal(await policy.locator('input[name="numeric_limit"]').inputValue(),state.limit)
        await policy.scrollIntoViewIfNeeded()
        await page.screenshot({path:`${directory}/${page.viewportSize().width}-numeric-policy-detail.png`})
        // Every catalog control has a visible text label; there are no icon-only controls.
        assert.equal(await page.locator('button').evaluateAll(nodes=>nodes.filter(node=>!node.textContent.trim()).length),0)
      })
    }})
  }
  else if(kind==='portal-usage'){
    await context.clearCookies()
    const number=async text=>{
      const language=await page.locator('html').getAttribute('lang')
      const parts=new Intl.NumberFormat(language==='es-US'?'es-US':'en-US').formatToParts(1234.5)
      const group=parts.find(part=>part.type==='group')?.value,decimal=parts.find(part=>part.type==='decimal')?.value??'.'
      return Number((group?text.replaceAll(group,''):text).replace(decimal,'.').replace(/[^0-9.-]/g,''))
    }
    const customerPath=state=>`/portal/upcoming?session=${encodeURIComponent(state.session.token)}&subscription=${state.subscription}&period=${state.period}`
    await entitlementQuotasFlow(h,owner,{onState:async state=>{
      await both(`quota-${state.code}-${state.used}`,customerPath(state))
    }})
    await commitments(h,owner,{onState:async state=>{
      await both(`commitment-${state.label}`,customerPath(state),async()=>{
        await Promise.all([page.waitForNavigation(),page.getByRole('button').click()])
        assert.ok(await page.locator('section.card').count())
        const cards=page.locator('section.card').filter({has:page.locator('h2').filter({hasText:/^(Minimum commitment|Compromiso mínimo)$/})})
        assert.equal(await cards.count(),state.commitments.length)
        for(const [index,window] of state.commitments.entries()){
          const values=await cards.nth(index).locator('dd').allTextContents()
          for(const [field,key] of ['nominalMinimumCents','minimumCents','earnedCents','trueUpCents','remainingCents'].entries())assert.equal(Math.round(await number(values[field])*100),window[key],'Rendered English and Spanish commitment figures equal exact customer facts')
        }
        assert.equal(await page.locator('button:not(:has-text("Refresh")):not(:has-text("Actualizar"))').count(),0,'Every control has a visible label')
      })
      if(state.commitments.some(window=>window.invoices.length)){
        await both(`commitment-${state.label}-invoice`,customerPath(state),async()=>{
          await page.locator('a[href^="/portal/invoices/"]').first().click()
          assert.equal(await page.locator('a[href^="/app/"]').count(),0)
        })
      }
    }})
    const records=await seedPortalRecords(h,owner)
    const session=await h.api('portal.session.issue',owner,{customer:records.customers[0],origin:h.origin,audience:'hosted'})
    await portalCorrections(h,owner,session,records.invoice.id,async state=>{
      await both(`correction-${state.kind}-${state.state}`,customerPath(state))
      if(state.state==='issued')await both(`explanation-${state.kind}`,`/portal/adjustments?session=${encodeURIComponent(state.session.token)}`)
    })
    await portalAnswersFlow(h,owner,async state=>{
      await both(`answer-${state.topic}`,`/portal/answers?${new URLSearchParams({session:state.session.token,invoice:state.invoice,question:state.question})}`)
    })
  }
  else if(kind==='prepaid')await prepaidBrowser({h,owner,page,context,both,form,submit})
  else if(kind==='native-collection')await nativeCollectionFlow(h,owner,{prepareRecovery:async request=>{const row=(await h.api('native-collections',owner)).find(r=>r.id===request);await page.goto(h.origin+`/app/invoices/${row.invoice_id}`);const review=form('collection.recovery.prepare').filter({has:page.locator(`input[name="request"][value="${request}"]`)});await submit(review);return (await h.api('native-collections',owner)).find(r=>r.id===request)},confirmRecovery:async payload=>{const row=(await h.api('native-collections',owner)).find(r=>r.id===payload.request);await page.goto(h.origin+`/app/invoices/${row.invoice_id}`);const review=form('collection.recovery.confirm').filter({has:page.locator(`input[name="recovery"][value="${payload.recovery}"]`)});await review.locator('input[name="confirm"]').check();await submit(review);return (await h.api('native-collections',owner)).find(r=>r.id===row.id)},confirm:async payload=>{await page.goto(h.origin+`/app/invoices/${(await h.api('native-collections',owner)).find(row=>row.id===payload.request).invoice_id}`);const consent=form('collection.confirm').filter({has:page.locator(`input[name="request"][value="${payload.request}"]`)}).filter({has:page.locator('button')});await consent.locator('input[name="confirm"]').check();await submit(consent);return (await h.api('native-collections',owner)).find(row=>row.id===payload.request)},onState:async state=>{await both(`native-${state.label}-${state.request?.id??state.invoice}`,`/app/invoices/${state.invoice}#collection`)}})
  else if(kind==='entity-setup')await contractEntitySetup(h,owner,{
    decideSetup:async(payload,actor)=>{
      assert.equal(actor,owner)
      await page.goto(h.origin+`/app/proposals/${payload.proposal}`)
      const decision=form('proposal.decide').filter({has:page.locator('input[name="decision"][value="approved"]')})
      await submit(decision)
      const saved=await h.api(`proposals/${payload.proposal}`,owner)
      assert.equal(saved.status,'approved')
      return {id:saved.id,...saved.result}
    },
    onState:async state=>{
      if(state.proposal)await both(`${state.label}-proposal`,`/app/proposals/${state.proposal}`)
      if(state.customer)await both(`${state.label}-customer`,`/app/customers/${state.customer}`)
      if(state.invoice)await both(`${state.label}-invoice`,`/app/invoices/${state.invoice}`)
    }
  })
  else if(kind==='cancellation')await cancellationBrowser({h,owner,context,page,both,form,submit})
  else if(kind==='numbering')await numberingEntitiesFlow(h,owner,{onState:async state=>{
    if(state.label==='entity-revenue'){
      await both('entity-revenue-consolidated','/app/revenue?from=2026-09&to=2026-09')
      for(const entity of [...state.entities,'business','imported']){
        await page.goto(h.origin+'/app/revenue?from=2026-09&to=2026-09')
        const selector=page.locator('form[method="get"]').filter({has:page.locator('select[name="entity"]')})
        await selector.locator('select[name="entity"]').selectOption(entity)
        await submit(selector)
        assert.equal(new URL(page.url()).searchParams.get('entity'),entity)
        await both(`entity-revenue-${entity}`,new URL(page.url()).pathname+new URL(page.url()).search)
      }
      for(const [index,invoice]of state.invoices.entries())await both(`entity-revenue-source-${index}`,`/app/revenue/${invoice}?from=2026-09&to=2026-09&entity=${state.entities[index]}`)
      return
    }
    await both(`numbering-${state.label}`,'/app/numbering')
    if(state.label==='entities')await both('numbering-entity-identity','/app/numbering',async()=>{
      await page.locator('details').filter({has:form('entity.update').filter({has:page.locator(`input[name="entity"][value="${state.entities[0]}"]`)})}).locator('summary').first().click()
    })
    if(state.label==='configured')await both('numbering-source-capture','/app/numbering',async()=>{
      const capture=form('invoice.series.capture')
      await capture.locator('xpath=ancestor::details[1]/summary').click()
      await capture.locator('select[name="entity"]').selectOption(state.entities[0])
      await capture.locator('select[name="source_invoice"]').selectOption(state.source)
      await capture.locator('textarea[name="capture"]').fill(JSON.stringify(state.settings.capture,null,2))
      await capture.locator('input[name="confirm"]').check()
    })
    if(state.label==='issued') {
      for(const [index,invoice]of state.invoices.slice(0,2).entries())await both(`numbering-issued-entity-${index+1}`,`/app/invoices/${invoice}`)
      await page.goto(h.origin+'/app/numbering')
      const filter=page.locator('form[method="get"][action="/app/numbering"]')
      await filter.locator('select[name="entity"]').selectOption(state.entities[0])
      await submit(filter)
      assert.equal(new URL(page.url()).searchParams.get('entity'),state.entities[0])
      await both('numbering-filtered-register',new URL(page.url()).pathname+new URL(page.url()).search)
      await both('numbering-customer',`/app/customers/${state.customers[0]}`)
    }
  }})
  else if(kind==='intervals') {
    await intervalsFlow(h,owner,{onState:async(label,subscription,invoice)=>{
      const detail=await h.api(`subscriptions/${subscription}`,owner),source=await h.api(`invoices/${invoice}`,owner)
      const suffix=label==='cadence-issued'?`${source.calculation.inputs.billing.terms.unit}-${source.calculation.inputs.billing.terms.count}`:label.replace('-issued','')
      await both(`intervals-${suffix}-subscription`,`/app/subscriptions/${subscription}?preview_period=${source.issue_date.slice(0,7)}#upcoming`)
      await both(`intervals-${suffix}-invoice`,`/app/invoices/${invoice}`)
      if(label==='annual-issued') {
        await both('intervals-catalog','/app/catalog')
        await both('intervals-customer',`/app/customers/${detail.customer_id}?preview_period=2027-01`)
        await both('intervals-run',`/app/billing/${source.bill_run_id}`)
        await both('intervals-billing','/app/billing')
        await both('intervals-revenue',`/app/revenue?from=2026-01&to=2028-01&customer=${detail.customer_id}`)
        await both('intervals-revenue-source',`/app/revenue/${invoice}?from=2026-01&to=2028-01&customer=${detail.customer_id}`)
        await both('intervals-mrr',`/app/reports/mrr?period=2026-01&customer=${detail.customer_id}`)
        await both('intervals-mrr-source',`/app/reports/mrr/${invoice}?period=2026-01&customer=${detail.customer_id}`)
        await both('intervals-retention','/app/retention')
      }
    }})
    await nativeIntervalForms({h,owner,page,both,form,submit})
  }
  else if(kind==='erasure')await erasureFlow(h,owner,async state=>{
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:950})
      await shot(state.label,state.path)
    }
  })
  else if(kind==='collection')await moveCollectionFlow(h,owner,{
    prepare:async(customer,invoice)=>{
      await page.goto(h.origin+`/app/customers/${customer}`)
      await page.locator('select[name="invoice"]').selectOption(invoice)
      await Promise.all([page.waitForURL('**/app/customers/**'),page.getByRole('button',{name:'Review original invoice',exact:true}).click()])
      return (await h.api(`customers/${customer}`,owner)).importedCollections.find(row=>row.invoice_id===invoice)
    },
    execute:async(customer,request)=>{
      await page.goto(h.origin+`/app/customers/${customer}`)
      const form=page.locator('form[action="/app/do/imported.collection.execute"]').filter({has:page.locator(`input[value="${request.id}"]`)})
      await form.locator('input[name="disable_auto_advance"]').check()
      await form.locator('input[name="confirm"]').check()
      await Promise.all([page.waitForURL('**/app/customers/**'),form.getByRole('button').click()])
      return (await h.api(`customers/${customer}`,owner)).importedCollections.find(row=>row.id===request.id)
    },
    finalize:async(customer,request)=>{
      await page.goto(h.origin+`/app/customers/${customer}`)
      const form=page.locator('form[action="/app/do/imported.collection.finalize"]').filter({has:page.locator(`input[value="${request.id}"]`)})
      await form.locator('input[name="confirm"]').check()
      await Promise.all([page.waitForURL('**/app/customers/**'),form.getByRole('button').click()])
      return (await h.api(`customers/${customer}`,owner)).importedCollections.find(row=>row.id===request.id)
    },
    onState:async state=>{for(const width of [1440,390]){await page.setViewportSize({width,height:950});await shot(`collection-${state.label}`,`/app/customers/${state.customer}`)}}
  })
  else await moveHistoryFlow(h,owner,{onState:async state=>{
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:950})
      if(state.label==='preview') {
        await shot('import-upload','/app/import')
        for(const [name,value]of Object.entries(state.capture))await page.locator(`input[name="${name}"]`).setInputFiles({name:`${name}.json`,mimeType:'application/json',buffer:Buffer.from(JSON.stringify(value))})
        await Promise.all([page.waitForURL('**/app/import/preview'),page.getByRole('button',{name:'Preview the move',exact:true}).click()])
        await shot('import-preview')
      } else {
        const paths=[['customer-history',`/app/customers/${state.customer}`],['import-applied','/app/import'],['mrr-history',`/app/reports/mrr?period=2026-06&customer=${state.customer}`],['billings',`/app/reports/billings?period=${state.period}&customer=${state.customer}`],['billings-source',`/app/reports/billings/${state.annual}?period=${state.period}&customer=${state.customer}`],['collections-source',`/app/reports/collections/${state.payment}?period=${state.period}&customer=${state.customer}`],['revenue',`/app/revenue?from=2026-07&to=2027-02&customer=${state.customer}`],['revenue-source',`/app/revenue/${state.annual}?from=2026-07&to=2027-02&customer=${state.customer}`],['frozen-report',`/app/report-deliveries/${state.delivery}`]]
        for(const [label,path]of paths)await shot(label,path)
      }
    }
  }})
  await writeFile(`${directory}/screens.json`,JSON.stringify({kind,captures},null,2))
} finally {await browser?.close();await h.close()}

async function nativeIntervalForms({h,owner,page,both,form,submit}) {
  await h.advanceClock('2034-01-01T20:00:00Z')
  await page.goto(h.origin+'/app/catalog')
  let fields=form('meter.create')
  await fields.locator('[name="code"]').fill('browser-calendar-calls')
  await fields.locator('[name="name"]').fill('Browser calendar calls')
  await fields.locator('[name="unit_label"]').fill('calls')
  await submit(fields)
  const meter=(await h.api('catalog',owner)).meters.find(row=>row.code==='browser-calendar-calls')
  assert.ok(meter)
  const prices=[]
  for(const row of [
    {code:'browser-calendar-annual',name:'Annual research platform',kind:'flat',amount:'1200',interval:'annual',timing:'advance'},
    {code:'browser-calendar-usage',name:'Monthly research usage',kind:'unit',amount:'2',interval:'month',timing:'arrears'},
  ]) {
    fields=form('product.create')
    await fields.locator('[name="code"]').fill(row.code)
    await fields.locator('[name="name"]').fill(row.name)
    await submit(fields)
    const product=(await h.api('catalog',owner)).products.find(product=>product.code===row.code)
    assert.ok(product)
    fields=form('price.create').filter({has:page.locator(`input[name="product"][value="${product.id}"]`)}).filter({has:page.locator('input[name="unit_amount"]')})
    await fields.locator('[name="kind"]').selectOption(row.kind)
    await fields.locator('[name="unit_amount"]').fill(row.amount)
    await fields.locator('[name="billing_interval"]').selectOption(row.interval)
    await fields.locator('[name="interval_count"]').fill('1')
    await fields.locator('[name="billing_timing"]').selectOption(row.timing)
    if(row.kind==='unit')await fields.locator('[name="meter"]').selectOption(meter.id)
    await fields.locator('[name="taxable"]').uncheck()
    await both(`forms-${row.code}-price`)
    await submit(fields)
    const price=(await h.api('catalog',owner)).prices.find(price=>price.product_id===product.id)
    assert.ok(price,'Submitting the native catalog form creates a real immutable price')
    assert.deepEqual([price.billing.unit,price.billing.count,price.billing.timing],row.kind==='flat'?['month',12,'advance']:['month',1,'arrears'])
    prices.push(price.id)
  }
  await both('forms-interval-catalog','/app/catalog')
  await page.goto(h.origin+'/app/customers')
  fields=form('customer.create')
  await fields.locator('[name="external_id"]').fill('synthetic-nectar-browser-calendar')
  await fields.locator('[name="name"]').fill('Calendar Field Research')
  await fields.locator('[name="billing_email"]').fill('field@browser-calendar.example')
  await both('forms-interval-new-customer')
  await submit(fields)
  const customer=(await h.api('customers',owner)).find(row=>row.external_id==='synthetic-nectar-browser-calendar')
  assert.ok(customer)
  fields=form('subscription.create')
  await fields.locator('[name="start_date"]').fill('2034-01-01')
  await fields.locator('[name="term_months"]').selectOption('12')
  await fields.locator('[name="billing_anchor_date"]').fill('2034-01-01')
  await fields.locator('select[name="price"]').nth(0).selectOption(prices[0])
  await fields.locator('select[name="price"]').nth(1).selectOption(prices[1])
  await both('forms-interval-new-subscription')
  await submit(fields)
  const subscription=new URL(page.url()).pathname.split('/').at(-1)
  const detail=await h.api(`subscriptions/${subscription}`,owner)
  assert.equal(detail.contract_end_date,'2035-01-01')
  assert.deepEqual(detail.items.map(item=>item.price_id).sort(),[...prices].sort())
  await both('forms-interval-upcoming',`/app/subscriptions/${subscription}?preview_period=2034-01#upcoming`)
  await both('forms-interval-customer',`/app/customers/${customer.id}?preview_period=2034-01`)
  const issue = async (month,expected) => {
    await page.goto(h.origin+'/app/billing')
    const prepare=form('billrun.prepare')
    await prepare.locator('[name="period"]').fill(month)
    await both(`forms-interval-${month}-prepare`)
    await submit(prepare)
    const run=new URL(page.url()).pathname.split('/').at(-1)
    const invoice=(await h.api(`runs/${run}`,owner)).invoices.find(invoice=>invoice.customer_id===customer.id)
    assert.ok(invoice)
    assert.equal(invoice.total_cents,expected)
    await both(`forms-interval-${month}-run`,`/app/billing/${run}`)
    await page.goto(h.origin+`/app/invoices/${invoice.id}`)
    await both(`forms-interval-${month}-draft`)
    const approve=form('invoice.approve')
    if(await approve.locator('[name="acknowledge"]').count())await approve.locator('[name="acknowledge"]').check()
    await submit(approve)
    assert.equal((await h.api(`invoices/${invoice.id}`,owner)).status,'approved')
    await both(`forms-interval-${month}-approved`)
    const finalize=form('invoice.finalise')
    await finalize.locator('[name="issue_date"]').fill(`${month}-01`)
    await submit(finalize)
    const issued=await h.api(`invoices/${invoice.id}`,owner)
    assert.equal(issued.status,'issued')
    assert.equal(issued.total_cents,expected)
    await both(`forms-interval-${month}-issued`)
    return issued
  }
  const annual=await issue('2034-01',120000)
  await h.api('usage.submit',owner,{events:[{event_id:'synthetic-nectar-browser-calendar-usage',customer:'synthetic-nectar-browser-calendar',meter:'browser-calendar-calls',quantity:'3',occurred_at:'2034-01-15T12:00:00Z'}]})
  await h.advanceClock('2034-02-01T20:00:00Z')
  const usage=await issue('2034-02',600)
  assert.deepEqual([usage.period_start,usage.period_end],['2034-01-01','2034-02-01'])
  const source=await h.api(`revenue/${annual.id}`,owner)
  assert.deepEqual(source.schedules[0].entries.map(entry=>entry.amountCents),Array(12).fill(10000))
  await both('forms-interval-final-customer',`/app/customers/${customer.id}?preview_period=2034-02`)
  await both('forms-interval-revenue',`/app/revenue?from=2034-01&to=2034-12&customer=${customer.id}`)
  await both('forms-interval-revenue-source',`/app/revenue/${annual.id}?from=2034-01&to=2034-12&customer=${customer.id}`)
  await both('forms-interval-mrr',`/app/reports/mrr?period=2034-01&customer=${customer.id}`)
  await both('forms-interval-billings',`/app/reports/billings?period=2034-01&customer=${customer.id}`)
  await both('forms-interval-billings-source',`/app/reports/billings/${annual.id}?period=2034-01&customer=${customer.id}`)
  await both('forms-interval-retention-cadence','/app/retention',async()=>{
    await form('retention.policy.prepare').locator('[name="save_price_id"]').selectOption(prices[0])
    await form('retention.policy.prepare').locator('[name="pause_price_id"]').selectOption(prices[0])
    await form('retention.policy.prepare').locator('[name="winback_price_id"]').selectOption(prices[0])
  })
}


async function cancellationBrowser({h,owner,context,page,both,form,submit}) {
  const subscriptions = new Map(), preparedModes = new Set(), decidedKinds = new Set()
  const asActor = async actor => context.addCookies(actor.split('; ').map(value=>{
    const index=value.indexOf('=')
    return {name:value.slice(0,index),value:value.slice(index+1),url:h.origin}
  }))
  await intervalCancellationFlow(h,owner,{
    prepareCancellation:async payload=>{
      await asActor(owner)
      const before=await h.api(`subscriptions/${payload.subscription}`,owner)
      const previous=new Set(before.cancellations.map(row=>row.id))
      await page.goto(h.origin+`/app/subscriptions/${payload.subscription}`)
      const cancel=form('subscription.cancel')
      await cancel.locator('[name="mode"]').selectOption(payload.mode)
      await cancel.locator('[name="effective_date"]').fill(payload.effective_date)
      await cancel.locator('[name="reason"]').fill(payload.reason)
      if(!preparedModes.has(payload.mode)) {
        await both(`cancellation-native-${payload.mode}-prepare`)
        preparedModes.add(payload.mode)
      }
      await submit(cancel)
      const after=await h.api(`subscriptions/${payload.subscription}`,owner)
      const request=after.cancellations.find(row=>!previous.has(row.id))
      if(!request)return {id:after.id,endDate:after.end_date}
      subscriptions.set(request.id,payload.subscription)
      return {id:after.id,cancellation:request.id,status:request.status,endDate:request.effective_date,
        credits:request.plan.plan.credits,amountCents:request.plan.plan.amountCents}
    },
    decideCancellation:async(payload,actor)=>{
      const subscription=subscriptions.get(payload.cancellation)
      assert.ok(subscription)
      await asActor(actor)
      try {
        await page.goto(h.origin+`/app/subscriptions/${subscription}`)
        const decision=form('subscription.cancel.decide').filter({has:page.locator(`input[name="cancellation"][value="${payload.cancellation}"]`)}).filter({has:page.locator(`input[name="decision"][value="${payload.decision}"]`)})
        assert.equal(await decision.count(),1)
        if(!decidedKinds.has(payload.decision)) {
          await both(`cancellation-native-${payload.decision}-review`)
          decidedKinds.add(payload.decision)
        }
        await submit(decision)
        const after=await h.api(`subscriptions/${subscription}`,actor),request=after.cancellations.find(row=>row.id===payload.cancellation)
        assert.equal(request.status,payload.decision)
        return {id:subscription,cancellation:request.id,status:request.status,endDate:after.end_date}
      } finally {await asActor(owner)}
    },
    onState:async state=>{
      await asActor(state.owner)
      const subject=state.index===undefined?'control':state.paid===0?'unpaid':state.paid===1188000?'paid':'part-paid'
      const label=`cancellation-${subject}-${state.label}`
      await both(`${label}-subscription`,`/app/subscriptions/${state.subscription}?preview_period=2026-07#lifecycle`)
      await both(`${label}-original-invoice`,`/app/invoices/${state.invoice}`)
      if(state.label==='pending-credit'&&state.index===2) {
        await asActor(state.finance)
        await both(`${label}-finance-credit-plan`,`/app/subscriptions/${state.subscription}#lifecycle`)
        await asActor(state.owner)
      }
      if(['approved','reactivated','restart-issued'].includes(state.label)&&state.index===2)await both(`${label}-customer-credit`,`/app/customers/${state.customer}?preview_period=2026-07`)
      if(state.label==='reactivated')await both(`${label}-upcoming`,`/app/subscriptions/${state.subscription}?preview_period=2026-07#upcoming`)
      if(state.label==='stale') {
        await asActor(state.finance)
        await page.goto(h.origin+`/app/subscriptions/${state.subscription}`)
        const decision=form('subscription.cancel.decide').filter({has:page.locator(`input[name="cancellation"][value="${state.request}"]`)}).filter({has:page.locator('input[name="decision"][value="approved"]')})
        await Promise.all([page.waitForNavigation({waitUntil:'load'}),decision.getByRole('button').click()])
        const refused=new URL(page.url())
        assert.equal(refused.searchParams.get('error'),'cancellation_stale')
        await both(`${label}-refused`,refused.pathname+refused.search)
        await asActor(state.owner)
      }
      if(state.restartInvoice) {
        await both(`${label}-restart-invoice`,`/app/invoices/${state.restartInvoice}`)
        await both(`${label}-revenue-source`,`/app/revenue/${state.invoice}?from=2026-01&to=2026-12&customer=${state.customer}`)
      }
    },
  })
}
