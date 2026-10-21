import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { file } from './harness.mjs'

// MOVE-011 partial: captured-source continuation, customer sequences, imported
// number collision refusal, and a complete read-only register through HTTP.
export async function numberingFlow(h, owner) {
  const api = (door,body,status) => h.api(door,owner,body,status)
  const initial=await api('business')
  const blockedNumber=`${initial.invoice_prefix}-${String(initial.next_invoice_number).padStart(initial.invoice_number_width,'0')}`
  const capture = {}
  for (const name of ['manifest','customers','products','prices','subscriptions','invoices','meters'])
    capture[name] = JSON.parse(await readFile(new URL(`../fixtures/stripe/${name}.json`,import.meta.url),'utf8'))
  capture.invoices.data[0].number='ACME-0041'
  capture.invoices.data[1].number='ACME-0042'
  capture.invoices.data[2].number='HARBOR-0007'
  capture.invoices.data.push({...structuredClone(capture.invoices.data[2]),id:'in_NumberHarborGap',number:'HARBOR-0009'})
  capture.invoices.data.push({...structuredClone(capture.invoices.data[2]),id:'in_NumberUnparsed',number:'MANUAL-REFERENCE'})
  capture.invoices.data.push({...structuredClone(capture.invoices.data[2]),id:'in_NumberInitialCollision',number:blockedNumber})
  capture.manifest.files.invoices.count=capture.invoices.data.length
  const files=Object.fromEntries(Object.entries(capture).map(([name,value])=>[name,file(`${name}.json`,JSON.stringify(value),'application/json')]))
  const preview=await api('import.preview',files)
  assert.equal(preview.create.invoice,6,'MOVE-011 retained invoice records include both extra captured numbers')
  await api('import.apply',{...files,fingerprint:preview.fingerprint})
  const customers=await api('customers')
  const atlas=customers.find(c=>c.external_id==='cus_NcAtlasFreight01').id
  const harbor=customers.find(c=>c.external_id==='cus_NcHarborAnalytics02').id
  const source=(await api('number-register')).entries.find(i=>i.number==='ACME-0042')
  const harborSource=(await api('number-register')).entries.find(i=>i.number==='HARBOR-0009')
  const series=async (body,status=200) => api('invoice.series',{revision:(await api('business')).revision,...body},status)
  const current=(await api('business')).revision
  await api('invoice.series',{revision:current-1,mode:'continue',source_invoice:source.id},409)
  await series({mode:'continue',source_invoice:source.id,customer:harbor},404)
  const draft=async (customer,label) => {
    const charge=await api('charge.add',{customer,amount:'100',description:label,effective_date:'2026-09-10'})
    return api('invoice.manual',{customer,charges:[charge.charge],service_date:'2026-09-10'})
  }
  const issue=async invoice => {
    await api('invoice.approve',{invoice:invoice.id,acknowledge:true})
    await api('invoice.finalise',{invoice:invoice.id,issue_date:'2026-09-10'})
    return api(`invoices/${invoice.id}`)
  }
  const refused=await draft(atlas,'Imported number collision must not issue')
  await api('invoice.approve',{invoice:refused.id,acknowledge:true})
  await api('invoice.finalise',{invoice:refused.id,issue_date:'2026-09-10'},409)
  assert.equal((await api('business')).next_invoice_number,initial.next_invoice_number,'MOVE-011 a refused number never consumes the sequence')
  assert.equal((await api(`invoices/${refused.id}`)).status,'approved','MOVE-011 a refused issue leaves the approval and invoice intact')
  const continued=await series({mode:'continue',source_invoice:source.id})
  assert.equal(continued.nextNumber,'ACME-0043','MOVE-011 captured width and prefix continue at the next number')
  const first=await issue(await draft(atlas,'Account continuation — first service'))
  const second=await issue(await draft(harbor,'Account continuation — second service'))
  assert.deepEqual([first.number,second.number],['ACME-0043','ACME-0044'],'MOVE-011 account-level invoices consume one sequence without gaps')
  await series({mode:'continue',source_invoice:source.id},409)
  await series({mode:'continue',source_invoice:harborSource.id,customer:harbor})
  assert.equal((await issue(await draft(harbor,'Customer sequence — harbor'))).number,'HARBOR-0010','MOVE-011 a customer has an independent captured sequence')
  assert.equal((await issue(await draft(atlas,'Account sequence stays independent'))).number,'ACME-0045')
  const before=await api(`invoices/${first.id}`)
  const credit=await api('credit.issue',{invoice:first.id,amount:'10',reason:'Service credit for the first capture-continuation cycle'})
  assert.ok(credit.number,'MOVE-011 native credit notes appear alongside invoice numbers')
  assert.deepEqual((await api(`invoices/${first.id}`)).calculation,before.calculation,'MOVE-011 numbering and credits preserve issued calculation evidence')
  await series({mode:'new',prefix:'FRESH',width:4})
  const fresh=await issue(await draft(atlas,'New series — first invoice'))
  assert.equal(fresh.number,'FRESH-0001','MOVE-011 a new prefix starts at one')
  await series({mode:'new',prefix:'ACME',width:4},409)

  const audit=await api('audit')
  const register=await api('number-register')
  assert.ok(register.entries.some(e=>e.source==='stripe'&&e.number==='ACME-0042'))
  assert.ok(register.entries.some(e=>e.source==='nectar'&&e.number==='ACME-0043'))
  assert.ok(register.entries.some(e=>e.kind==='credit-note'&&e.number===credit.number))
  assert.deepEqual(register.gaps.filter(g=>g.prefix==='ACME-'),[],'MOVE-011 a fully captured account sequence plus local continuation has no internal gaps')
  const gap=register.gaps.find(g=>g.prefix==='HARBOR-')
  assert.deepEqual([gap.from,gap.to,gap.count],['HARBOR-0008','HARBOR-0008','1'],'MOVE-011 missing numbers are reported as exact inclusive internal ranges')
  assert.ok(register.unparsed.some(e=>e.number==='MANUAL-REFERENCE'),'MOVE-011 unparseable retained numbers are listed honestly')
  assert.equal(register.entries.filter(e=>e.number===blockedNumber).length,1,'MOVE-011 imported collision is present once and no native invoice claims it')
  const csv=await h.page('/app/exports/number-register.csv',owner)
  for(const value of ['ACME-0042','ACME-0043','FRESH-0001','HARBOR-0008',credit.number]) assert.ok(csv.includes(value),'MOVE-011 exported register and gap rows retain exact numbers')
  assert.deepEqual(await api('audit'),audit,'MOVE-011 register, CSV and report reads create no audit writes')
  await h.api('number-register',undefined,undefined,401)
  await api('access.give',{email:'number-accountant@example.test',name:'Numbering Accountant',role:'accountant'})
  const accountant=await h.signIn('number-accountant@example.test',{requested:true})
  assert.deepEqual(await h.api('number-register',accountant),register,'MOVE-011 the accountant sees the same unified numbered register')
  await h.api('invoice.series',accountant,{revision:(await api('business')).revision,mode:'new',prefix:'NO',width:4},403)
  const agent={bearer:(await api('credential.issue',{name:'Read-only number observer',scopes:['prepare']})).key}
  await h.api('invoice.series',agent,{revision:(await api('business')).revision,mode:'new',prefix:'NO',width:4},403)
  assert.equal((await h.raw('/app/exports/number-register.csv',agent)).status,403,'MOVE-011 register reads do not confer export authority')
  console.log('MOVE-011 captured account/customer continuation, new series, collision refusal, register, gaps, CSV and authority passed')
  return {atlas,harbor,source,harborSource,first,second,fresh,refused,register}
}
