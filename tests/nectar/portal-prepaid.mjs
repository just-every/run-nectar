import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { prepaidFlow } from './prepaid.mjs'
import { csvRows } from './financial-reports.mjs'
import { file } from './harness.mjs'

function assertRenderedLot(html,lot,locale,catalogue) {
  const cards=[...html.matchAll(/<section\b[^>]*class="card"[^>]*>([\s\S]*?)<\/section>/g)].map(match=>match[1])
  const card=cards.find(card=>card.includes(`href="${lot.href}?`)||card.includes(`href="${lot.href}"`))
  assert.ok(card,`The rendered card links to its exact prepaid source ${lot.id}`)
  const text=html=>html.replace(/<[^>]*>/g,'').replace(/&nbsp;|&#160;/g,' ').trim()
  const fields=new Map([...card.matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g)].map(match=>[text(match[1]),text(match[2])]))
  const parts=new Intl.NumberFormat(locale).formatToParts(1234.5)
  const group=parts.find(part=>part.type==='group')?.value,decimal=parts.find(part=>part.type==='decimal')?.value??'.'
  const number=value=>{
    assert.equal(typeof value,'string','Each financial quantity has a rendered labelled value')
    const digits=value.match(/[−-]?\d[\d.,\s  ]*/)?.[0]
    assert.ok(digits,`A numeric amount is visible in ${value}`)
    const normalized=(group?digits.replaceAll(group,''):digits).replaceAll(decimal,'.').replaceAll('−','-').replace(/[\s  ]/g,'')
    assert.ok(Number.isFinite(Number(normalized)))
    return Number(normalized)
  }
  for(const [key,expected,scale] of [['remaining',lot.remainingN,lot.kind==='money'?100:1000000],['available',lot.availableN,lot.kind==='money'?100:1000000],['liability',lot.liabilityCents,100]]){
    const value=fields.get(catalogue[`portal.prepaid.${key}`])
    assert.equal(Math.round(number(value)*scale),expected,`The ${locale} ${key} amount on ${lot.id} equals its exact financial source`)
    if(lot.kind==='money'||key==='liability')assert.match(value,/USD/,'Money remains denominated in USD')
  }
}

export async function portalPrepaidFlow(h,owner,{onState=async()=>{}}={}) {
  let proved=false
  await prepaidFlow(h,owner,{onState:async state=>{
    if(!state.units||proved)return
    proved=true
    const api=(path,body,status)=>h.api(path,owner,body,status),{row,units}=state
    const spanishCustomer=await api(`customers/${units.customer}`)
    await api('customer.update',{customer:units.customer,revision:spanishCustomer.revision,name:spanishCustomer.name,billing_email:spanishCustomer.billing_email,address:spanishCustomer.address,language:'es-US'})
    const otherOrigin=new URL(h.origin);otherOrigin.hostname='localhost'
    await api('portal.configure',{hosts:[h.origin,otherOrigin.origin],parents:[]})
    const issue=customer=>api('portal.session.issue',{customer,origin:h.origin,audience:'hosted'})
    const moneySession=await issue(row.customer),unitSession=await issue(units.customer)
    const open=(session,path,headers={})=>h.raw(`${path}${path.includes('?')?'&':'?'}session=${encodeURIComponent(session.token)}`,{headers})
    const json=async(session,path,status=200)=>{
      const response=await open(session,path,{accept:'application/json'})
      assert.equal(response.status,status)
      if(status!==200)return
      assert.equal(response.headers.get('cache-control'),'no-store')
      const data=await response.json()
      assert.doesNotMatch(JSON.stringify(data),/\/app\/|provider_ref|paymentIntent|authorization|prepared_by|request_id|terms_json|synthetic-nectar-payment-|@example|PRIVATE-|INTERNAL-/)
      return data
    }
    const parity=async(session,subscription)=>{
      const data=await json(session,'/portal/prepaid/data'),ledger=await api(`prepaid/${subscription}`)
      assert.equal(data.date,ledger.date)
      assert.equal(data.lots.length,ledger.grants.length,'Exhausted grants retain their typed source ledger')
      for(const lot of data.lots){
        assert.equal(lot.subscription,subscription)
        const grant=ledger.grants.find(grant=>`prepaid-${grant.id}`===lot.id)
        assert.ok(grant)
        assert.deepEqual([lot.remainingN,lot.availableN,lot.liabilityCents],[grant.remainingN,grant.availableN,grant.liabilityCents])
        assert.equal(lot.entries.reduce((sum,entry)=>sum+entry.amountN,0),lot.remainingN)
        assert.equal(lot.entries.reduce((sum,entry)=>sum+entry.liabilityCents,0),lot.liabilityCents)
        if(lot.source==='promotion')assert.equal(lot.liabilityCents,0,'Promotional units and money carry no paid liability')
        const source=await json(session,lot.href)
        assert.deepEqual(source.lot,lot)
        const sourceHtml=await open(session,lot.href,{accept:'text/html'})
        assert.equal(sourceHtml.status,200)
        assert.doesNotMatch(await sourceHtml.text(),/portal\.prepaid\.|\/app\/|provider_ref|synthetic-nectar-payment-/)
        if(lot.purchaseInvoice)assert.equal((await open(session,lot.purchaseInvoice.href)).status,200,'Purchase source is an owned issued portal invoice')
      }
      const csv=await open(session,'/portal/prepaid.csv')
      assert.equal(csv.status,200)
      const rows=csvRows(await csv.text())
      assert.equal(rows.length,data.lots.reduce((sum,lot)=>sum+lot.entries.length,0))
      const number=text=>Number(text.replace(/^'/,''))
      for(const lot of data.lots){
        const own=rows.filter(entry=>entry.source_id===lot.id),scale=lot.kind==='money'?100:1000000
        assert.equal(Math.round(own.reduce((sum,entry)=>sum+number(entry.quantity_change),0)*scale),lot.remainingN)
        assert.equal(Math.round(own.reduce((sum,entry)=>sum+number(entry.liability_change),0)*100),lot.liabilityCents)
        assert.ok(own.every(entry=>entry.source_path===lot.href))
      }
      return data
    }
    const before={audit:await api('audit'),runs:await api('runs'),invoices:await api('invoices'),money:await api(`prepaid/${row.subscription}`),units:await api(`prepaid/${units.subscription}`)}
    const money=await parity(moneySession,row.subscription),unitData=await parity(unitSession,units.subscription)
    assert.equal(money.lots.filter(lot=>lot.kind==='money').reduce((sum,lot)=>sum+lot.availableN,0),590000)
    assert.equal(money.lots.reduce((sum,lot)=>sum+lot.liabilityCents,0),590000)
    assert.ok(unitData.lots.some(lot=>lot.kind==='units'&&lot.remainingQuantity!==null))
    const english=await open(moneySession,'/portal/prepaid'),spanish=await open(unitSession,'/portal/prepaid')
    assert.equal(english.status,200);assert.equal(spanish.status,200)
    assert.match(await english.text(),/USD 5,000\.00/)
    const spanishHtml=await spanish.text()
    assert.match(spanishHtml,/lang="es-US"/)
    assert.doesNotMatch(spanishHtml,/portal\.prepaid\.|untranslated_key|Contract liability|Purchased credit|Promotional credit/)
    const spanishCatalogue=JSON.parse(await readFile(new URL('../../src/nectar/locales/es-US.json',import.meta.url),'utf8'))
    for(const lot of unitData.lots)assertRenderedLot(spanishHtml,lot,spanishCatalogue['language.intl'],spanishCatalogue)
    await json(unitSession,money.lots[0].href,404)
    await json(moneySession,unitData.lots[0].href,404)
    const ignored=await json(moneySession,`/portal/prepaid/data?customer=${units.customer}&subscription=${units.subscription}`)
    assert.deepEqual(ignored,money,'Query parameters cannot replace the signed customer principal')
    assert.deepEqual({audit:await api('audit'),runs:await api('runs'),invoices:await api('invoices'),money:await api(`prepaid/${row.subscription}`),units:await api(`prepaid/${units.subscription}`)},before,'All portal reads and CSVs leave grants, drawdowns, expiry, funding and invoices unchanged')
    const finance=await h.signIn('synthetic-nectar-301@example.test')
    const addition=await api('prepaid.prepare',{subscription:units.subscription,mode:'grant',kind:'units',source:'promotion',amount:'1',meter:units.meter,effective_date:'2026-03-15',expires_date:'2026-05-01',priority:0,expiry_consent:true})
    await h.api('prepaid.decide',finance,{request:addition.request,decision:'approved'})
    const refreshed=await parity(unitSession,units.subscription)
    assert.equal(refreshed.lots.reduce((sum,lot)=>sum+(lot.kind==='units'?lot.availableN:0),0),unitData.lots.reduce((sum,lot)=>sum+(lot.kind==='units'?lot.availableN:0),0)+1000000,'The same signed session immediately sees an approved new grant')
    await onState({h,owner,row,units,moneySession,unitSession,money,unitData:refreshed,paths:['/portal/prepaid',money.lots[0].href]})

    // Existing import doors create a real shadow subscription. Even its own
    // customer capability cannot expose a shadow prepaid grant.
    const captures={}
    for(const name of ['manifest','customers','products','prices','subscriptions','invoices','meters'])captures[name]=file(`${name}.json`,await readFile(new URL(`../fixtures/stripe/${name}.json`,import.meta.url),'utf8'),'application/json')
    const preview=await api('import.preview',captures)
    await api('import.apply',{...captures,fingerprint:preview.fingerprint})
    const shadow=(await api('subscriptions')).find(sub=>sub.billing_mode==='shadow')
    assert.ok(shadow)
    const shadowGrant=await api('prepaid.prepare',{subscription:shadow.id,mode:'grant',kind:'money',source:'promotion',amount:'333',effective_date:'2026-03-15',expires_date:'2026-05-01',priority:0,expiry_consent:true})
    await h.api('prepaid.decide',finance,{request:shadowGrant.request,decision:'approved'})
    const shadowSession=await issue(shadow.customer_id)
    assert.deepEqual((await json(shadowSession,'/portal/prepaid/data')).lots,[])
    await json(shadowSession,`/portal/prepaid/prepaid-${shadowGrant.request}`,404)
    const paths=['/portal/prepaid','/portal/prepaid/data','/portal/prepaid.csv',money.lots[0].href]
    for(const path of paths){
      assert.equal((await h.raw(path)).status,401)
      assert.equal((await open({token:moneySession.token.slice(0,-1)+(moneySession.token.endsWith('A')?'B':'A')},path)).status,401)
      assert.equal((await h.dispatch(new Request(`${otherOrigin.origin}${path}?session=${encodeURIComponent(moneySession.token)}`))).status,401)
    }
    const revoked=await issue(row.customer)
    await api('portal.session.revoke',{session:revoked.id})
    for(const path of paths)assert.equal((await open(revoked,path)).status,401)
    const erased=await api('erasure.request',{customer:shadow.customer_id})
    await api('erasure.verify',{request:erased.id,reason:'Independently verified customer identity',evidence:file('shadow-owner.txt','Synthetic owner verification','text/plain')})
    await api('erasure.approve',{request:erased.id,confirm:true})
    for(const path of paths)assert.equal((await open(shadowSession,path)).status,401)
    await h.advanceClock(new Date(moneySession.expiresAt).toISOString())
    for(const path of paths)assert.equal((await open(moneySession,path)).status,401)
    await h.advanceClock('2026-03-15T18:00:00Z')
  }})
  assert.ok(proved)
  console.log('Portal prepaid: exact paid/promotional money and units, source ledger/CSV, immediate refresh, Spanish, ownership, shadow/erasure/session boundaries and read-only custody')
}
