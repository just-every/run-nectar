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
      } catch { outgoing.writeHead(500);outgoing.end('Local HTTPS transport failed') }
    })
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
    const port = server.address().port
    portalOrigin = `https://billing.example.com:${port}`;appOrigin=`https://app.example.com:${port}`
    app = portalApp({ portalOrigin,sessionForRequest:async()=>active,name:'Fieldnote' })
    const { customers,invoice,invoices } = await seedPortalRecords(h,owner)
    await h.api('portal.configure',owner,{ hosts:[portalOrigin],parents:[appOrigin],brand_name:'Fieldnote Billing',brand_color:'#245c46' })
    const issue = (customer,audience) => h.api('portal.session.issue',owner,{ customer,origin:portalOrigin,audience,...(audience==='embedded'?{parent:appOrigin}:{}) })
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
      await frame.getByRole('button',{name:'Solicitar eliminación de datos personales'}).click()
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
