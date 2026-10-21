// PORT-005: a real HTTPS merchant application frames the built Nectar Worker.
// Local TLS/DNS transport replaces hosting only; billing/auth/data remain real.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:https'
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { portalApp } from '../../examples/portal/app.mjs'
import { seedPortalRecords } from './portal-sessions.mjs'
import { csvRows } from './financial-reports.mjs'

async function seedPortalIntervals(h, owner, customers) {
  const api=(path,body)=>h.api(path,owner,body)
  const meter=(await api('meter.create',{code:'portal-calendar-calls',name:'Portal calendar calls',unit_label:'calls'})).id
  const prices=[]
  for(const [suffix,kind,amount,interval,timing] of [['annual','flat','12000','annual','advance'],['usage','unit','2','monthly','arrears']]){
    const product=(await api('product.create',{code:`portal-calendar-${suffix}`,name:`Portal calendar ${suffix}`})).id
    prices.push((await api('price.create',{product,kind,unit_amount:amount,taxable:false,billing_interval:interval,billing_timing:timing,...(kind==='unit'?{meter}:{})})).id)
  }
  const subscriptions=[]
  for(const [index,customer] of customers.slice(0,2).entries()){
    subscriptions.push((await api('subscription.create',{customer,start_date:'2025-10-01',term_months:24,price:prices})).id)
    await api('usage.submit',{events:[{event_id:`synthetic-portal-calendar-${index+1}`,customer:index?'PORT005-PC':'PORT005-NW',meter:'portal-calendar-calls',quantity:index?'900':'3',occurred_at:'2026-09-15T12:00:00Z'}]})
  }
  return {subscription:subscriptions[0],foreign:subscriptions[1],prices}
}

async function portalIntervalProjection(h, owner, session, origin, fixture) {
  const open=path=>h.dispatch(new Request(`${origin}${path}${path.includes('?')?'&':'?'}session=${session.token}`))
  const state=async()=>({audit:await h.api('audit',owner),runs:await h.api('runs',owner),invoices:await h.api('invoices',owner)})
  const before=await state()
  const endpoint=`/portal/subscriptions/${fixture.subscription}/upcoming`
  const response=await open(endpoint+'?period=2026-10')
  assert.equal(response.status,200,'Customer calendar preview supports annual advance and monthly arrears')
  const preview=await response.json()
  assert.equal(preview.billingMonth,'2026-10')
  assert.deepEqual((await (await open(endpoint)).json()).invoices,preview.invoices,'Default customer month uses the business clock')
  assert.equal(preview.invoices.length,1,'One customer invoice composes every service window due on the same day')
  assert.deepEqual(preview.invoices.map(row=>row.calculation.totalCents).sort((a,b)=>a-b),[1200600])
  const operator=await h.api(`subscriptions/${fixture.subscription}/upcoming?period=2026-10`,owner)
  for(const row of preview.invoices){
    const source=operator.invoices.find(invoice=>invoice.period.start===row.period.start&&invoice.period.end===row.period.end)
    assert.ok(source)
    assert.equal(row.calculation.fingerprint,source.calculation.fingerprint)
    assert.equal(row.calculation.totalCents,source.calculation.totalCents)
    assert.equal(row.billingTerms,null)
    assert.deepEqual(row.servicePeriods.map(part=>[part.period.start,part.period.end,part.terms.timing]).sort(),[['2026-09-01','2026-10-01','arrears'],['2026-10-01','2027-10-01','advance']])
    assert.equal(row.billingDueDate,'2026-10-01')
    assert.equal(row.calculation.inputs,undefined,'Customer reads never return saved raw inputs')
    assert.equal(row.calculation.exceptions,undefined,'Operator exceptions remain private')
    assert.equal(row.billingWindow,undefined,'Internal component claims are not a customer read model')
    assert.ok(row.calculation.lines.every(line=>line.evidence===undefined))
  }
  assert.doesNotMatch(JSON.stringify(preview),/PRIVATE-|INTERNAL-|synthetic-portal-calendar-2/)
  const csv=await open(`/portal/usage.csv?subscription=${fixture.subscription}&period=2026-10`)
  assert.equal(csv.status,200)
  const usageRows=csvRows(await csv.text())
  assert.deepEqual(usageRows.map(row=>({meter:row.meter,from:row.period_start,to:row.period_end,quantity:Number(row.quantity),earlier:Number(row.earlier_quantity)})),[
    {meter:'portal-calendar-calls',from:'2026-09-01',to:'2026-10-01',quantity:3,earlier:0},
  ],'Usage CSV exports only the actual metered service window, with no invented annual fee usage row')
  assert.equal(preview.invoices[0].meters.length,1,'Only the metered service has a usage projection')
  for(const path of [`/portal/subscriptions/${fixture.foreign}/upcoming?period=invalid`,`/portal/upcoming?subscription=${fixture.foreign}&period=2026-10`,`/portal/usage.csv?subscription=${fixture.foreign}&period=2026-10`])
    assert.equal((await open(path)).status,404,'Foreign subscriptions are refused before calendar or period reads')
  assert.deepEqual(await state(),before,'Customer calendar and CSV reads create no billing or audit records')
  return preview
}

export async function portalEmbeddingFlow(h, owner) {
  const scratch = await mkdtemp(join(tmpdir(),'nectar-portal-tls-'))
  const evidence = process.env.NECTAR_EVIDENCE_DIR
  let server, browser, active, hosted, embedded
  try {
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(scratch,'key.pem'),'-out',join(scratch,'cert.pem'),'-days','1','-subj','/CN=billing.example.com','-addext','subjectAltName=DNS:billing.example.com,DNS:app.example.com,DNS:other.example.com'],{stdio:'ignore'})
    let portalOrigin, appOrigin, app
    server = createServer({ key:await readFile(join(scratch,'key.pem')),cert:await readFile(join(scratch,'cert.pem')) },async (incoming,outgoing) => {
      try {
        const origin = `https://${incoming.headers.host}`
        const chunks=[];for await (const bytes of incoming) chunks.push(bytes)
        const request = new Request(origin+incoming.url,{ method:incoming.method,headers:incoming.headers,...(!['GET','HEAD'].includes(incoming.method)?{body:Buffer.concat(chunks)}:{}) })
        const response = origin === portalOrigin ? await h.dispatch(request) : [appOrigin,appOrigin.replace('app.','other.')].includes(origin) ? await app(request) : new Response(null,{status:404})
        outgoing.writeHead(response.status,Object.fromEntries(response.headers))
        outgoing.end(Buffer.from(await response.arrayBuffer()))
      } catch(error) { console.error('PORT-005 HTTPS transport:',String(error.message).replace(/session=[^&\s]+/g,'session=[redacted]'));outgoing.writeHead(500);outgoing.end('Local HTTPS transport failed') }
    })
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
    const port = server.address().port
    portalOrigin = `https://billing.example.com:${port}`;appOrigin=`https://app.example.com:${port}`
    app = portalApp({ portalOrigin,sessionForRequest:async()=>active,name:'Fieldnote' })
    await h.advanceClock('2026-10-21T09:00:00Z')
    const { customers,invoice,invoices } = await seedPortalRecords(h,owner)
    const intervals=await seedPortalIntervals(h,owner,customers)
    await h.api('portal.configure',owner,{ hosts:[portalOrigin],parents:[appOrigin],brand_name:'Fieldnote Billing',brand_color:'#245c46' })
    const issue = (customer,audience) => h.api('portal.session.issue',owner,{ customer,origin:portalOrigin,audience,...(audience==='embedded'?{parent:appOrigin}:{}) })
    const calendarSession=await issue(customers[0],'hosted')
    const preview=await portalIntervalProjection(h,owner,calendarSession,portalOrigin,intervals)
    assert.ok(preview.invoices.every(row=>row.state==='preview'))
    const run=await h.api('billrun.prepare',owner,{period:'2026-10'})
    const drafts=(await h.api(`runs/${run.id}`,owner)).invoices.filter(row=>row.customer_id===customers[0])
    const intervalDrafts=[]
    for(const draft of drafts){
      const source=await h.api(`invoices/${draft.id}`,owner)
      if(source.subscription_id!==intervals.subscription)continue
      intervalDrafts.push(source)
      await h.api('invoice.approve',owner,{invoice:draft.id,acknowledge:true})
      await h.api('invoice.finalise',owner,{invoice:draft.id,issue_date:'2026-10-01'})
    }
    assert.equal(intervalDrafts.length,1)
    const frozen=await portalIntervalProjection(h,owner,calendarSession,portalOrigin,intervals)
    assert.ok(frozen.invoices.every(row=>row.state==='issued'))
    assert.deepEqual(frozen.invoices.map(row=>row.calculation),preview.invoices.map(row=>row.calculation),'Ordinary issue preserves the customer calculation for each real window')
    await h.api('usage.submit',owner,{events:[{event_id:'synthetic-portal-calendar-late',customer:'PORT005-NW',meter:'portal-calendar-calls',quantity:'7',occurred_at:'2026-09-20T12:00:00Z'}]})
    assert.deepEqual((await portalIntervalProjection(h,owner,calendarSession,portalOrigin,intervals)).invoices,frozen.invoices,'Late ingestion cannot rewrite issued customer usage or annual charges')
    browser = await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic','--no-proxy-server','--host-resolver-rules=MAP billing.example.com 127.0.0.1,MAP app.example.com 127.0.0.1,MAP other.example.com 127.0.0.1']})
    const context = await browser.newContext({ignoreHTTPSErrors:true}),page=await context.newPage()
    const shot = async name => {
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`PORT-005 ${name} fits merchant app`)
      if (evidence) { await mkdir(evidence,{recursive:true});await page.screenshot({path:join(evidence,`${page.viewportSize().width}-${name}.jpg`),type:'jpeg',quality:82,fullPage:true}) }
    }
    for (const width of [1440,390]) {
      await h.advanceClock('2026-10-21T09:00:00Z')
      await page.setViewportSize({width,height:844})
      hosted=await issue(customers[0],'hosted');embedded=await issue(customers[0],'embedded');active=embedded
      assert.equal((await h.dispatch(new Request(hosted.url))).status,200,'PORT-005 branded request dispatch preserves its public origin')
      await page.goto(appOrigin+'/billing')
      const frame=page.frameLocator('iframe')
      await frame.getByRole('heading',{name:'Billing overview',exact:true}).waitFor()
      assert.match(await frame.locator('main').innerText(),/Northwind Robotics/)
      assert.doesNotMatch(await frame.locator('main').innerText(),/Pinecrest|PRIVATE-|INTERNAL-/)
      assert.equal(await frame.locator('html').evaluate(node=>node.scrollWidth>innerWidth),false,'PORT-005 embedded portal fits phone and desktop')
      await shot('sample-app-overview')
      await frame.locator(`a[href*="/portal/invoices/${invoice.id}"]`).click()
      await frame.getByRole('heading',{name:'Charges',exact:true}).waitFor()
      assert.match(await frame.locator('main').innerText(),/USD 175\.00/)
      await shot('sample-app-invoice')
      await frame.getByRole('link',{name:'Privacy request',exact:true}).click()
      await frame.getByRole('heading',{name:'Privacy request',exact:true}).waitFor()
      await shot('sample-app-privacy')
      const response=await page.goto(hosted.url)
      assert.equal(response.status(),200,'PORT-005 actual branded hostname reaches the Worker')
      assert.equal(new URL(page.url()).hostname,'billing.example.com')
      assert.match(await page.title(),/Fieldnote Billing/)
      assert.equal(await page.locator('.merchant').innerText(),'Fieldnote Billing')
      assert.equal(await page.locator('.merchant').evaluate(node=>getComputedStyle(node).borderTopColor),'rgb(36, 92, 70)','PORT-005 merchant accent is rendered')
      assert.equal(await page.locator('a[href="/app"],img[src*="/brand/"]').count(),0,'PORT-005 no operator navigation or Nectar mark on branded customer pages')
      await shot('branded-overview')
      await page.locator(`a[href*="/portal/invoices/${invoice.id}"]`).click()
      await page.getByRole('heading',{name:'Charges',exact:true}).waitFor()
      await shot('branded-invoice')
      await page.goto(`${portalOrigin}/portal/upcoming?session=${hosted.token}&subscription=${intervals.subscription}&period=2026-10`)
      await page.getByRole('heading',{name:'Usage and upcoming invoice',exact:true}).waitFor()
      assert.equal(await page.locator('main section.card').count(),1,'Customer page renders one composed invoice with both actual service windows')
      assert.equal(await page.getByRole('heading',{name:'Issued invoice',exact:true}).count(),1)
      assert.equal(await page.locator('input[name="period"]').inputValue(),'2026-10','Refresh keeps the due month rather than replacing it with the first service month')
      const upcomingText=await page.locator('main').innerText()
      assert.match(upcomingText,/USD 12,000\.00/)
      assert.match(upcomingText,/USD 6\.00/)
      assert.match(upcomingText,/September 1, 2026 – October 1, 2026/)
      assert.match(upcomingText,/October 1, 2026 – October 1, 2027/)
      assert.doesNotMatch(upcomingText,/Pinecrest|PRIVATE-|INTERNAL-/)
      await shot('branded-mixed-calendar')
      const foreign=invoices.find(row=>row.customer_id===customers[1])
      assert.equal((await page.goto(`${portalOrigin}/portal/invoices/${foreign.id}?session=${hosted.token}`)).status(),404,'PORT-005 branded host refuses foreign invoice')
      await shot('branded-foreign-refused')
      const security=[];page.on('console',message=>{if(message.type()==='error')security.push(message.text())})
      active=embedded
      await page.goto(appOrigin.replace('app.','other.')+'/billing');await page.waitForLoadState('networkidle')
      assert.ok(security.some(text=>text.includes('frame-ancestors')),'PORT-005 browser enforces signed parent origin')
      await shot('unapproved-parent-refused')
      security.length=0;active=hosted
      await page.goto(appOrigin+'/billing');await page.waitForLoadState('networkidle')
      assert.ok(security.some(text=>text.includes('frame-ancestors')),'PORT-005 hosted sessions cannot be framed')
      await shot('hosted-framing-refused')
      active=await issue(customers[1],'embedded')
      await page.goto(appOrigin+'/billing')
      await frame.getByRole('heading',{name:'Resumen de facturación',exact:true}).waitFor()
      assert.match(await frame.locator('main').innerText(),/Pinecrest Labs/)
      assert.doesNotMatch(await frame.locator('main').innerText(),/Northwind/)
      await shot('sample-app-spanish')
      await frame.getByRole('link',{name:'Solicitud de privacidad',exact:true}).click()
      const privacyResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/portal/privacy')
      await frame.getByRole('button',{name:'Solicitar eliminación de datos personales'}).click()
      const submitted=await privacyResponse
      assert.equal(submitted.status(),303,'PORT-005 embedded privacy form uses the ordinary scoped redirect')
      assert.equal(submitted.request().headers().origin,portalOrigin,'PORT-005 native form proves its exact origin')
      assert.ok(!submitted.request().headers().referer?.includes('session='),'PORT-005 native form never discloses a session in its referrer')
      await frame.getByRole('heading',{name:'Solicitud registrada.',exact:false}).waitFor()
      await shot('sample-app-spanish-privacy-requested')
      await h.advanceClock(new Date(hosted.expiresAt).toISOString())
      assert.equal((await page.goto(hosted.url)).status(),401,'PORT-005 branded expired session is refused at its exact deadline')
      await shot('branded-expired')
      const rejected=page.waitForResponse(response=>response.url().startsWith(portalOrigin+'/portal?')&&response.status()===401)
      active=embedded;await page.goto(appOrigin+'/billing');await rejected
      await shot('sample-app-expired')
    }
    console.log('PORT-005 real sample app, merchant branding, HTTPS host binding, customer isolation, parent CSP, privacy form and expiry passed at 1440/390')
  } finally { if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(scratch,{recursive:true,force:true}) }
}
