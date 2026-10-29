// Existing-customer setup custody through the actual archive commands.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { chromium } from '@playwright/test'
import { readArchive } from '@runeditrun/rer/modules/portability'
import { command } from './cli.mjs'
import { harness, file } from './harness.mjs'
import { nativeCollectionEdge } from './native-collection.mjs'
import { hostedSetupEdge } from './customer-payment-methods.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { totp } from './mfa.mjs'

const instant='2026-10-22T10:00:00Z'
const email=n=>[`synthetic-nectar-${n}`,'example.test'].join('@')
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?`[${value.map(canonical).join(',')}]`:`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
const hash=value=>createHash('sha256').update(value).digest('hex')
const sensitive=['4242'.repeat(4),'123456789012','synthetic-nectar-810','synthetic-nectar-1']
const history=items=>items.filter(item=>item.table==='nc_hosted_setup_history').map(item=>item.row).sort((a,b)=>a.id.localeCompare(b.id))
async function archiveItems(path) {
  const bytes=await readFile(path),items=[]
  for await(const record of readArchive(new ReadableStream({start(c){c.enqueue(bytes);c.close()}})))if(record.kind==='part')items.push(...record.items.map(({index,...item})=>item))
  return items
}
function excludes(bytes,values,label) {
  for(const value of values)assert.ok(!bytes.includes(value),`${label} excludes sensitive input`)
}
async function storageBytes(directory) {
  const chunks=[]
  for(const entry of await readdir(directory,{recursive:true,withFileTypes:true}))if(entry.isFile())chunks.push(await readFile(join(entry.parentPath,entry.name)))
  return Buffer.concat(chunks).toString('latin1')
}

export async function hostedSetupArchiveJourney() {
  assert.equal(process.env.NECTAR_TEST_CHECKOUT,'1','Use only a disposable checkout: this journey resets local state')
  const root=process.cwd()
  for(const path of ['.dev.vars','.wrangler/state'])await access(join(root,path)).then(()=>{throw new Error('A fresh unconfigured checkout is required')},error=>{if(error.code!=='ENOENT')throw error})
  await mkdir('exports',{recursive:true})
  const scratch=await mkdtemp(join(root,'exports','hosted-setup-archive-'))
  const archive=name=>join(scratch,`${name}.rer`),outputs=[]
  const run=async(args,options)=>{const output=await command(root,args,options);outputs.push(output);console.log('SETUP_ARCHIVE command',args[0],options?.refuse?'refused':'passed');return output}
  const config=JSON.parse(await readFile('wrangler.jsonc','utf8'))
  const persistence=join(root,'.wrangler/state/v3'),databaseId=config.d1_databases.find(row=>row.binding==='DB').database_id
  const native=nativeCollectionEdge(),refs=[1,3,4,5,6,7,8].map(n=>`synthetic-nectar-native-customer-${n}`)
  for(const ref of refs)native.customers.set(ref,{account:1,method:null})
  const edge=hostedSetupEdge(native.fetch,{customerRefs:refs})
  const traffic=[]
  const stripeFetch=async request=>{
    traffic.push({method:request.method,path:new URL(request.url).pathname})
    const response=await edge.fetch(request)
    // Plant full inputs at the only substituted boundary, beside valid safe fields.
    if(response.headers.get('content-type')?.includes('application/json')){
      const value=await response.json()
      if(value.object==='payment_method'){
        if(value.card)value.card.number=sensitive[0]
        if(value.us_bank_account)value.us_bank_account.account_number=sensitive[1]
      }
      return Response.json(value,{status:response.status})
    }
    return response
  }
  const writes=()=>traffic.filter(row=>row.method!=='GET').length
  let h,browser,owner,settings,factor,restarts=0
  const api=(path,body,status)=>h.api(path,owner,body,status)
  const issue=customer=>api('portal.session.issue',{customer,origin:h.origin,audience:'hosted'})
  const post=async(session,operation,setup,{cookie,body={},status=200}={})=>{
    const response=await h.raw(`/portal/payment-methods/${operation}?session=${encodeURIComponent(session.token)}`,{cookie,body:{setup,confirm:true,...body},headers:{accept:'application/json'}})
    const result=await response.json()
    assert.equal(response.status,status,`Setup ${operation}: ${JSON.stringify(result)}`)
    return {result,cookie:response.headers.getSetCookie().find(row=>row.startsWith('nectar_setup_return=')&&!row.includes('Max-Age=0'))?.split(';')[0]}
  }
  const currentRows=async customer=>(await api(`customers/${customer}`)).billingRecord.hostedSetups
  const readPage=async session=>{
    const response=await h.raw(`/portal/payment-methods?session=${encodeURIComponent(session.token)}`)
    assert.equal(response.status,200);return response.text()
  }
  async function restart({fresh=false}={}) {
    await h?.close()
    const time=new Date(Date.parse(instant)+60000*restarts++).toISOString()
    h=await harness({assets:true,persistence,databaseId,applyMigrations:false,settings,localTime:time,stripeFetch,stripeSecret:sensitive[3]})
    if(fresh)assert.equal((await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar owner'}})).status,303)
    owner=await h.signIn(h.vars.OWNER_EMAIL)
    // Reuse the test authenticator only in memory, through the ordinary factor door.
    if(factor)await api('mfa.verify',{code:totp(factor.secret,Date.parse(time))})
    await api('portal.configure',{hosts:[h.origin],parents:[]})
  }
  const money=async customer=>{
    const record=await api(`customers/${customer}`)
    return {ledger:record.ledger,collections:(await api(`reports/collections?period=2026-10&customer=${customer}`)).totalCents,subscriptions:record.subscriptions}
  }
  try {
    await run(['export','--output',archive('empty')])
    await restart({fresh:true})
    await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
    await api('business.configure',{legal_name:'Synthetic Nectar Merchant',timezone:'UTC',invoice_prefix:'SETUP',payment_terms_days:30})
    await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Reviewed setup archive journey'})
    await api('tax.review',{revision:(await api('business')).revision})
    factor=await api('mfa.totp.start',{})
    await api('mfa.totp.confirm',{factor:factor.factor,code:totp(factor.secret,Date.parse(instant))})
    const targets=[]
    for(const [index,ref] of refs.entries()){
      const customer=(await api('customer.create',{external_id:`synthetic-nectar-archive-${index}`,name:`Synthetic setup ${index}`,billing_email:email(900+index)})).id
      const binding=(await api('collection.customer.bind',{customer,account_ref:'synthetic-nectar-native-account-1',stripe_customer_ref:ref,confirm:true})).id
      targets.push({customer,binding,ref})
    }
    const [updating,creating,open,erased,peer,failed,unaccepted]=targets,expected=[]
    async function capture(target,{method='card',makeDefault=false,outcome='complete'}={}){
      const session=await issue(target.customer)
      const setup=await api('checkout.setup.prepare',{customer:target.customer,binding:target.binding,method,confirm:true})
      const html=await readPage(session),consentHash=html.match(/name="consent_hash" value="([^"]+)"/)?.[1]
      assert.ok(consentHash)
      if(outcome==='creating')edge.setFault('lose-create')
      const started=await post(session,'start',setup.id,{body:{consent_hash:consentHash,make_default:makeDefault},status:outcome==='creating'?502:200})
      assert.ok(started.cookie)
      let status=outcome==='creating'?'creating':'open'
      if(outcome==='failed'){edge.expire(setup.id);await post(session,'reconcile',setup.id,{cookie:started.cookie});status='failed'}
      if(['complete','updating'].includes(outcome)){
        if(method==='us_bank_account')edge.sessions.get(setup.id).mandate.customer_acceptance.accepted_at=1792663183
        edge.complete(setup.id)
        if(outcome==='updating')edge.setFault('lose-default')
        await post(session,'finish',setup.id,{cookie:started.cookie,status:outcome==='updating'?502:200})
        status=outcome
      }
      const row=(await currentRows(target.customer)).find(row=>row.id===setup.id)
      assert.equal(row.status,status);assert.equal(row.defaultChoice,makeDefault)
      const provider=edge.sessions.get(setup.id)
      expected.push({id:setup.id,customer:target.customer,method,status,makeDefault,consentHash,session,returnCookie:started.cookie,provider})
      return setup.id
    }
    const card=await capture(updating,{makeDefault:true})
    const ach=await capture(updating,{method:'us_bank_account'})
    await capture(updating,{makeDefault:true,outcome:'updating'})
    await capture(creating,{outcome:'creating'})
    await capture(open,{outcome:'open'})
    await capture(erased,{makeDefault:true})
    await capture(failed,{outcome:'failed'})
    const abandoned=await api('checkout.setup.prepare',{customer:unaccepted.customer,binding:unaccepted.binding,method:'card',confirm:true})
    // Nonempty, independently known financial facts must survive setup restoration.
    const charge=(await api('charge.add',{customer:updating.customer,amount:'100',description:'Synthetic service',effective_date:'2026-10-22',taxable:false})).charge
    const invoice=(await api('invoice.manual',{customer:updating.customer,charges:[charge],service_date:'2026-10-22'})).id
    await api('invoice.approve',{invoice,acknowledge:true});await api('invoice.finalise',{invoice,issue_date:'2026-10-22'})
    const payment=(await api('payment.record',{customer:updating.customer,amount:'30',method:'check',reference:'synthetic-nectar-archive-cash',received_on:'2026-10-22'})).payment
    await api('payment.allocate',{payment,invoice,amount:'30'})
    const financial=await money(updating.customer)
    assert.deepEqual([financial.ledger.invoicedCents,financial.ledger.paidCents,financial.ledger.balanceCents,financial.collections],[10000,3000,7000,3000])
    assert.deepEqual(financial.subscriptions,[],'Setup never creates a subscription')
    await h.assertStorageExcludes([...sensitive,...expected.flatMap(row=>[row.session.token,row.returnCookie.split('=')[1]])])
    settings={...h.vars};await h.close();h=null
    excludes(await storageBytes(join(persistence,'d1')),sensitive,'Database bytes')
    await run(['export','--output',archive('before')])
    const before=await archiveItems(archive('before')),captured=history(before)
    assert.equal(captured.length,expected.length)
    assert.ok(!captured.some(row=>row.id===abandoned.id),'Unaccepted preparation creates no portable consent evidence')
    for(const item of expected){
      const row=captured.find(row=>row.id===item.id),wording=JSON.parse(row.consent_json)
      assert.equal(row.customer_id,item.customer);assert.equal(row.method,item.method);assert.equal(row.status,item.status)
      assert.equal(row.account_ref,'synthetic-nectar-native-account-1');assert.equal(row.customer_ref,item.provider.session.customer)
      assert.equal(row.session_ref,item.status==='creating'?null:item.provider.session.id)
      assert.equal(row.default_choice,Number(item.makeDefault));assert.equal(row.accepted_at,Date.parse(instant))
      assert.equal(row.completed_at,item.status==='complete'?Date.parse(instant):null)
      assert.equal(row.previous_default_ref,item.customer===updating.customer&&item.id!==card?expected.find(row=>row.id===card).provider.method.id:null)
      assert.equal(wording.merchant,'Synthetic Nectar Merchant');assert.equal(wording.method,item.method)
      assert.ok(wording.version&&wording.purpose&&wording.save&&wording.default)
      assert.equal(hash(canonical(wording)),item.consentHash);assert.equal(row.consent_hash,item.consentHash)
      if(item.status==='complete'||item.status==='updating'){
        const method=JSON.parse(row.method_json)
        assert.equal(method.methodRef,item.provider.method.id);assert.equal(method.last4,item.method==='card'?'4242':'6789')
        assert.equal(method.setupIntentRef,item.provider.setup.id,'Archive retains the matching provider setup reference')
        if(item.method==='us_bank_account'){
          assert.equal(method.mandateRef,item.provider.mandate.id);assert.equal(method.mandateText,null)
          assert.equal(method.mandateStatus,item.provider.mandate.status,'Archive retains the observed mandate outcome')
          assert.equal(method.mandateAcceptedAt,item.provider.mandate.customer_acceptance.accepted_at*1000)
          assert.equal(method.mandateAcceptanceType,'online');assert.equal(method.mandateTextVersion,null)
          assert.notEqual(method.mandateAcceptedAt,row.accepted_at,'Provider acceptance is not reconstructed from the native consent clock')
        }
      }
    }
    const achProvider=expected.find(row=>row.id===ach).provider
    const achAudit=before.find(item=>item.table==='nc_audit'&&item.row.subject===ach&&item.row.action==='checkout.setup.complete')
    const achFacts=JSON.parse(achAudit.row.detail)
    assert.equal(achFacts.setupIntentRef,achProvider.setup.id)
    assert.equal(achFacts.mandateRef,achProvider.mandate.id)
    assert.equal(achFacts.mandateStatus,achProvider.mandate.status)
    assert.equal(achFacts.mandateAcceptedAt,achProvider.mandate.customer_acceptance.accepted_at*1000)
    assert.equal(achFacts.mandateAcceptanceType,'online')
    assert.notEqual(captured.find(row=>row.id===card).default_choice,captured.find(row=>row.id===ach).default_choice)
    for(const table of ['nc_hosted_setups','nc_hosted_setup_returns','nc_portal_sessions','nc_automatic_collection_authorizations'])assert.ok(!before.some(item=>item.table===table),'Archives exclude executable authority')
    excludes(JSON.stringify(before),[...sensitive,...expected.flatMap(row=>[row.session.token,row.returnCookie.split('=')[1]])],'Archive contents')
    const writeCount=writes(),trafficCount=traffic.length
    await run(['reset','--yes']);await run(['import','--input',archive('before'),'--yes'])
    await run(['export','--output',archive('restored')])
    const restoredArchive=await archiveItems(archive('restored'))
    assert.deepEqual(history(restoredArchive),captured,'Actual restore preserves every historical evidence byte')
    assert.deepEqual(restoredArchive.find(item=>item.table==='nc_audit'&&item.row.seq===achAudit.row.seq),achAudit,'Actual restore preserves the original mandate audit facts')
    await restart({fresh:true})
    assert.deepEqual(await money(updating.customer),financial)
    for(const target of [...targets.slice(0,4),failed]){
      const rows=await currentRows(target.customer)
      assert.equal(rows.length,expected.filter(row=>row.customer===target.customer).length)
      assert.ok(rows.every(row=>row.historical&&!row.debitAuthority))
      for(const row of rows){
        const stored=JSON.parse(captured.find(item=>item.id===row.id).method_json??'null')
        if(stored){
          assert.equal(row.paymentMethod.setupIntentRef,stored.setupIntentRef)
          assert.equal(row.paymentMethod.mandateStatus,stored.mandateStatus)
          assert.equal(row.paymentMethod.mandateAcceptedAt,stored.mandateAcceptedAt)
        }
      }
    }
    assert.deepEqual(await currentRows(unaccepted.customer),[],'Restoration does not revive an unaccepted setup')
    await post(await issue(unaccepted.customer),'start',abandoned.id,{status:404})
    assert.deepEqual(await currentRows(peer.customer),[],'A foreign customer receives no setup evidence')
    const foreignPage=await readPage(await issue(peer.customer))
    excludes(foreignPage,['4242','6789',...expected.map(row=>row.id)],'Foreign customer page')
    for(const row of expected){
      const session=await issue(row.customer),foreign=await issue(peer.customer)
      for(const operation of ['start','finish','reconcile']){
        await post(row.session,operation,row.id,{cookie:row.returnCookie,status:401})
        if(operation!=='start')await post(session,operation,row.id,{cookie:row.returnCookie,status:401})
        await post(session,operation,row.id,{status:404,body:{consent_hash:row.consentHash,make_default:true}})
        await post(foreign,operation,row.id,{status:404})
      }
      assert.equal((await h.raw('/portal/payment-methods',{cookie:row.returnCookie})).status,401)
    }
    const beforeRefusedPreparation=traffic.length
    for(const target of [updating,creating,open])assert.equal((await api('checkout.setup.prepare',{customer:target.customer,binding:target.binding,method:'card',confirm:true},409)).error,'hosted_setup_historical_uncertainty')
    assert.equal(traffic.length,beforeRefusedPreparation,'Unresolved history blocks replacement before any provider access')
    // The historical uncertainty fence must refuse before a provider request.
    assert.equal(writes(),writeCount)
    assert.equal((await h.raw(`/cdn-cgi/local/scheduled?time=${Date.parse(instant)}&cron=${encodeURIComponent('0 * * * *')}`)).status,200)
    assert.equal(writes(),writeCount,'Old sessions, returns and scheduled ticks perform zero provider writes')
    assert.equal(traffic.length,trafficCount,'Restoration and historical views initiate no provider traffic')
    assert.deepEqual(await money(updating.customer),financial)
    console.log('SETUP_ARCHIVE restored completed card and ACH, creating, open and updating histories; replay is inert')
    // Browser proof uses the same restored installation and current customer doors.
    browser=await chromium.launch({headless:true,...process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{},args:['--no-sandbox','--use-mock-keychain','--password-store=basic']})
    const page=await browser.newPage(),directory=process.env.NECTAR_EVIDENCE_DIR
    if(directory)await mkdir(directory,{recursive:true})
    for(const [label,target] of [['updating',updating],['creating',creating],['open',open],['failed',failed]])for(const language of ['en','es-US']){
      const strings=JSON.parse(await readFile(`src/nectar/locales/${language}.json`,'utf8'))
      const record=await api(`customers/${target.customer}`)
      await api('customer.update',{customer:target.customer,revision:record.revision,name:record.name,billing_email:record.billing_email,language})
      const session=await issue(target.customer)
      for(const width of directory?[1440,390]:[1440]){
        await page.setViewportSize({width,height:950})
        const response=await page.goto(h.origin+`/portal/payment-methods?session=${encodeURIComponent(session.token)}`)
        if(width===1440){
          assert.equal(response.status(),200)
          assert.equal(await page.locator('html').getAttribute('lang'),language)
          assert.equal(await page.locator('input[name=setup]').count(),0,'Historical pages offer no execution form')
          assert.ok((await page.textContent('main')).includes(strings['checkout.historical']),'Historical evidence is explicitly labelled')
          if(label==='updating')assert.ok((await page.textContent('main')).includes('4242')&&(await page.textContent('main')).includes('6789'))
          if(label==='updating')assert.ok((await page.textContent('main')).includes(strings['checkout.mandate.unavailable']),'Unavailable ACH authorization wording stays explicit')
          assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
          assert.equal(await page.locator('button,a').evaluateAll(nodes=>nodes.filter(node=>!node.textContent.trim()).length),0)
        }
        if(directory)await page.screenshot({path:join(directory,`${width}-${language}-${label}-historical.png`),fullPage:true})
      }
      await api('portal.session.revoke',{session:session.id})
      for(const width of directory?[1440,390]:[1440]){
        await page.setViewportSize({width,height:950})
        const response=await page.reload()
        if(width===1440){
          assert.equal(response.status(),401)
          assert.equal(await page.locator('html').getAttribute('lang'),'en','An unavailable session uses the contracted English fallback')
          excludes(await page.textContent('main'),['4242','6789','Synthetic Nectar Merchant'],'Refused customer page')
          assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
        }
        if(directory)await page.screenshot({path:join(directory,`${width}-${language}-${label}-refused.png`),fullPage:true})
      }
    }
    await browser.close();browser=null
    // A terminal history is evidence only. New work needs current authority and acceptance.
    const newlyAccepted=[],ordinaryOwner=await h.signIn(h.vars.OWNER_EMAIL)
    for(const target of [erased,failed,unaccepted]){
      const input={customer:target.customer,binding:target.binding,method:'card',confirm:true}
      await h.api('checkout.setup.prepare',ordinaryOwner,input,403)
      const beforeFresh=writes(),session=await issue(target.customer)
      const setup=await api('checkout.setup.prepare',input)
      assert.equal(writes(),beforeFresh,'Fresh preparation itself grants no provider write')
      await post(await issue(peer.customer),'start',setup.id,{status:404})
      await post(session,'start',setup.id,{status:409,body:{consent_hash:'synthetic-nectar-unaccepted'}})
      assert.equal(writes(),beforeFresh,'Old history and a current session never replace current explicit acceptance')
      if(target!==erased)continue
      const html=await readPage(session),consentHash=html.match(/name="consent_hash" value="([^"]+)"/)?.[1]
      assert.ok(consentHash)
      const started=await post(session,'start',setup.id,{body:{consent_hash:consentHash,make_default:false}})
      edge.complete(setup.id)
      await post(session,'finish',setup.id,{cookie:started.cookie})
      assert.equal(writes(),beforeFresh+1,'Current acceptance creates exactly one setup and no default change')
      const saved=(await currentRows(target.customer)).find(row=>row.id===setup.id)
      assert.equal(saved.status,'complete');assert.equal(saved.historical,false);assert.equal(saved.debitAuthority,false)
      assert.equal(saved.defaultChoice,false)
      newlyAccepted.push({id:setup.id,session,returnCookie:started.cookie,provider:edge.sessions.get(setup.id)})
      const event=(await api('audit')).find(row=>row.subject===setup.id&&row.action==='checkout.setup.complete')
      assert.equal(JSON.parse(event.detail).setupIntentRef,edge.sessions.get(setup.id).setup.id)
      await post(session,'finish',setup.id,{cookie:started.cookie,status:401})
      assert.equal(writes(),beforeFresh+1,'Replayed current completion creates no further write')
    }
    const authorizedWriteCount=writes()
    const request=await api('erasure.request',{customer:erased.customer})
    await api('erasure.verify',{request:request.id,reason:'Independent synthetic setup owner verification',evidence:file('synthetic-nectar-setup-owner.txt','Synthetic independently checked owner')})
    await api('erasure.approve',{request:request.id,confirm:true})
    const erasedRecord=await api(`customers/${erased.customer}`)
    assert.ok(erasedRecord.erased_at);assert.deepEqual(erasedRecord.billingRecord?.hostedSetups??[],[])
    settings={...h.vars};await h.close();h=null
    await run(['export','--output',archive('erased')])
    const anonymized=await archiveItems(archive('erased'))
    assert.deepEqual(history(anonymized),captured.filter(row=>row.customer_id!==erased.customer),'Erasure removes setup evidence without consuming peers')
    const privateRow=expected.find(row=>row.customer===erased.customer)
    const erasedReferences=[privateRow,...newlyAccepted].flatMap(row=>[row.provider.method.id,row.provider.setup.id])
    excludes(JSON.stringify(anonymized),[email(903),...erasedReferences],'Anonymized archive')
    await run(['reset','--yes'])
    const refused=await run(['import','--input',archive('before'),'--journal',relative(root,archive('erased')),'--yes'],{refuse:true})
    assert.match(refused,/later_journal|erased_row|erasure_epoch/,'An older archive is refused against known erasure custody')
    await run(['import','--input',archive('erased'),'--yes'])
    await run(['export','--output',archive('anonymized-restored')])
    assert.deepEqual(history(await archiveItems(archive('anonymized-restored'))),history(anonymized))
    await restart({fresh:true})
    const restoredErased=await api(`customers/${erased.customer}`)
    assert.ok(restoredErased.erased_at);assert.deepEqual(restoredErased.billingRecord?.hostedSetups??[],[])
    await api('portal.session.issue',{customer:erased.customer,origin:h.origin,audience:'hosted'},404)
    for(const row of [privateRow,...newlyAccepted])for(const operation of ['start','finish','reconcile'])await post(row.session,operation,row.id,{cookie:row.returnCookie,status:401})
    assert.deepEqual(await money(updating.customer),financial)
    assert.equal(writes(),authorizedWriteCount,'Anonymized restore revives no setup or collection authority')
    excludes(outputs.join('\n'),sensitive,'CLI logs')
    await h.assertStorageExcludes([...sensitive,...erasedReferences])
    console.log('SETUP_ARCHIVE actual export, reset and import; exact consent custody, unchanged cents, erasure refusal and anonymized restore passed')
  } finally {await browser?.close();await h?.close();await rm(scratch,{recursive:true,force:true})}
}

if(process.argv[1]===new URL(import.meta.url).pathname)await hostedSetupArchiveJourney()
