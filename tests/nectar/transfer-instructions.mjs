// Real Worker, D1, owner confirmation, native issue and own-customer views.
// Stripe is substituted only at its network edge; no settlement is asserted.
import assert from 'node:assert/strict'
import { file } from './harness.mjs'
import { totp } from './mfa.mjs'

export function transferInstructionEdge() {
  const calls=[],customers=new Map(Array.from({length:8},(_,i)=>[`synthetic-nectar-transfer-${i+1}`,{livemode:false,manual:true}]))
  let account='synthetic-nectar-transfer-account',lose=false,invalid=false,foreignCash=false,ambiguous=false
  const fetch=async request=>{
    const path=new URL(request.url).pathname.replace('/v1',''),method=request.method
    calls.push({path,method,key:request.headers.get('Idempotency-Key')})
    if(path==='/account')return Response.json({object:'account',id:account})
    const match=path.match(/^\/customers\/([^/]+)(?:\/(cash_balance|funding_instructions))?$/),id=match?.[1],customer=customers.get(id)
    if(!customer)return Response.json({},{status:404})
    if(!match[2])return Response.json({object:'customer',id,livemode:customer.livemode,invoice_settings:{}})
    if(match[2]==='cash_balance')return Response.json({object:'cash_balance',customer:foreignCash?'synthetic-nectar-foreign':id,livemode:customer.livemode,settings:{reconciliation_mode:customer.manual?'manual':'automatic'}})
    assert.equal(method,'POST')
    assert.deepEqual(Object.fromEntries(new URLSearchParams(await request.text())),{funding_type:'bank_transfer',currency:'usd','bank_transfer[type]':'us_bank_transfer'})
    assert.ok(request.headers.get('Idempotency-Key'))
    if(lose){lose=false;return Response.json({},{status:503})}
    const address={type:'aba',supported_networks:['ach','domestic_wire_us'],aba:{bank_name:'Synthetic Remittance Bank',account_holder_name:'Synthetic Merchant Treasury',account_number:invalid?'invalid':'990000123456',routing_number:'110000000',account_type:'checking',private_note:'synthetic-nectar-private-bank-note'}}
    return Response.json({object:'funding_instructions',funding_type:'bank_transfer',currency:'usd',livemode:false,
      private_metadata:'synthetic-nectar-private-provider-field',bank_transfer:{type:'us_bank_transfer',country:'US',financial_addresses:[address,{type:'swift',supported_networks:['swift'],swift:{bank_name:'Synthetic international bank',swift_code:'synthetic-nectar-private-swift'}},...(ambiguous?[{...address,aba:{...address.aba,account_number:'990000654321'}}]:[])]}})
  }
  return {fetch,calls,customers,setAccount(value){account=value},lose(){lose=true},invalid(value){invalid=value},ambiguous(value){ambiguous=value},foreignCash(value){foreignCash=value}}
}
let edge
export const harnessOptions=()=>{edge=transferInstructionEdge();return {stripeFetch:edge.fetch,stripeSecret:'synthetic-nectar-1'}}
const expected={bankName:'Synthetic Remittance Bank',accountHolderName:'Synthetic Merchant Treasury',accountNumber:'990000123456',routingNumber:'110000000',accountType:'checking',networks:['ach','domestic_wire_us'],currency:'USD',country:'US',testMode:true}
export async function transferInstructionsFlow(h,owner,{onState=async()=>{}}={}) {
  const api=(path,body,status)=>h.api(path,owner,body,status)
  let instant=Date.parse('2026-10-29T12:00:00Z')
  await h.advanceClock(new Date(instant).toISOString())
  await api('business.configure',{...await api('business'),timezone:'UTC'})
  const customers=[]
  for(let i=1;i<=8;i++)customers.push((await api('customer.create',{external_id:`synthetic-nectar-transfer-${i}`,name:`Transfer customer ${i}`,billing_email:h.vars.OWNER_EMAIL})).id)
  const account_ref='synthetic-nectar-transfer-account'
  const prepare=customer=>api('transfer.instructions.prepare',{customer,account_ref})
  const read=async customer=>(await api(`customers/${customer}/transfer-instructions`)).instructions
  const posts=()=>edge.calls.filter(row=>row.method==='POST').length
  await api('transfer.instructions.prepare',{customer:customers[0],account_ref},403)
  const mfa=await api('mfa.totp.start',{})
  const fresh=()=>api('mfa.verify',{method:'totp',code:totp(mfa.secret,instant)})
  await api('mfa.totp.confirm',{factor:mfa.factor,code:totp(mfa.secret,instant)})
  const entityTerms={legal_name:'Synthetic transfer treasury',address:'Synthetic Way',ein:'11-3456789',invoice_prefix:'TRANSFER',invoice_number_width:4,payment_terms_days:30,processor_account_ref:account_ref,ledger_company_ref:'synthetic-nectar-transfer-ledger',tax_registration:'Synthetic registration'}
  const entity=(await api('entity.create',{revision:(await api('business')).revision,...entityTerms})).id
  await api('customer.entity',{revision:(await api('business')).revision,customer:customers[0],entity,confirm:true})

  for(let i=1;i<=8;i++)await api('collection.customer.bind',{customer:customers[i-1],account_ref,stripe_customer_ref:`synthetic-nectar-transfer-${i}`,confirm:true})
  const issue=async(customer,description='Transfer service')=>{
    const charge=await api('charge.add',{customer,amount:'100',description,effective_date:'2026-10-28',taxable:false})
    const draft=await api('invoice.manual',{customer,charges:[charge.charge],service_date:'2026-10-28'})
    await api('invoice.approve',{invoice:draft.id,acknowledge:true})
    await api('invoice.finalise',{invoice:draft.id,issue_date:'2026-10-28'})
    return api(`invoices/${draft.id}`)
  }
  const old=await issue(customers[0],'Previously issued service')
  assert.equal(old.transfer_instructions_json,null)
  await api('portal.configure',{hosts:[h.origin],parents:[]})
  const session=customer=>api('portal.session.issue',{customer,origin:h.origin,audience:'hosted'})
  const path=(token,invoice,format='')=>`${invoice?`/portal/invoices/${invoice}`:'/portal'}?session=${encodeURIComponent(token)}${format?`&format=${format}`:''}`
  const pdf=async(token,invoice)=>{
    const response=await h.raw(path(token,invoice,'pdf'));assert.equal(response.status,200)
    assert.equal(response.headers.get('content-type'),'application/pdf')
    return [...Buffer.from(await response.arrayBuffer()).toString('latin1').matchAll(/<([0-9a-f]+)> Tj/g)].map(m=>Buffer.from(m[1],'hex').toString('latin1')).join('\n')
  }
  const originalSession=await session(customers[0]),oldPdf=await pdf(originalSession.token,old.id)
  const review=await prepare(customers[0]),competing=await prepare(customers[0])
  assert.deepEqual([review.review.customer,review.review.accountRef,review.review.customerRef,review.review.currency,review.review.testMode],[customers[0],account_ref,'synthetic-nectar-transfer-1','USD',true])
  for(const change of [{confirm:false},{customer:customers[1]},{account_ref:'synthetic-nectar-foreign'},{stripe_customer_ref:'synthetic-nectar-transfer-2'},{binding_revision:'synthetic-nectar-stale'},{currency:'EUR'},{test_mode:false}])
    await api('transfer.instructions.confirm',{...review.confirm,...change},change.confirm===false?400:409)
  edge.customers.get('synthetic-nectar-transfer-1').livemode=true
  await api('transfer.instructions.confirm',review.confirm,409)
  edge.customers.get('synthetic-nectar-transfer-1').livemode=false
  edge.customers.get('synthetic-nectar-transfer-1').manual=false
  await api('transfer.instructions.confirm',review.confirm,409)
  edge.customers.get('synthetic-nectar-transfer-1').manual=true
  edge.foreignCash(true);await api('transfer.instructions.confirm',review.confirm,409);edge.foreignCash(false)
  edge.setAccount('synthetic-nectar-foreign');await api('transfer.instructions.confirm',review.confirm,409);edge.setAccount(account_ref)
  assert.equal(posts(),0,'Unsafe identity, mode and reconciliation refusals make no provider write')
  const credential=await api('credential.issue',{name:'Synthetic transfer observer',scopes:['prepare']})
  const financeAddress=['synthetic-nectar-finance','example.test'].join('@')
  await api('access.give',{email:financeAddress,name:'Finance',role:'finance'})
  const finance=await h.signIn(financeAddress,{requested:true})
  for(const who of [undefined,finance,{bearer:credential.key}])for(const action of ['transfer.instructions.prepare','transfer.instructions.confirm'])await h.api(action,who,review.confirm,who?403:401)
  for(const who of [finance,{bearer:credential.key}])await h.api(`customers/${customers[0]}/transfer-instructions`,who,undefined,403)
  await api('credential.revoke',{key:credential.id})
  await h.api('transfer.instructions.confirm',{bearer:credential.key},review.confirm,401)
  await h.rejectAudit('transfer.instructions.claim')
  assert.equal((await h.raw('/api/nectar/transfer.instructions.confirm',{cookie:owner,body:review.confirm})).status,500)
  await h.rejectAudit(null)
  assert.deepEqual(await read(customers[0]),[]);assert.equal(posts(),0,'Audit failure rolls back the claim before the network write')
  const concurrent=await Promise.all([1,2].map(()=>h.raw('/api/nectar/transfer.instructions.confirm',{cookie:owner,body:review.confirm})))
  assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409])
  const available=await concurrent.find(r=>r.status===200).json()
  assert.equal(available.status,'available');assert.deepEqual(available.instructions,expected)
  await api('transfer.instructions.confirm',review.confirm,409)
  await api('transfer.instructions.confirm',competing.confirm,409)
  await api('transfer.instructions.prepare',{customer:customers[0],account_ref},409)
  assert.equal(posts(),1,'Concurrent confirmation and replay request funding instructions once')
  await h.assertStorageExcludes(['synthetic-nectar-private-provider-field','synthetic-nectar-private-bank-note','synthetic-nectar-private-swift','Synthetic international bank'])
  const first=await issue(customers[0]),second=await issue(customers[0]),foreign=await issue(customers[1])
  for(const invoice of [first,second]) {
    const snapshot=JSON.parse(invoice.transfer_instructions_json)
    assert.deepEqual(snapshot.fields,expected);assert.equal(snapshot.instructionId,available.id)
    assert.match(snapshot.sourceHash,/^[a-f0-9]{64}$/)
    assert.deepEqual([invoice.total_cents,invoice.paidCents,invoice.balanceCents],[10000,0,10000],'Instruction issuance moves no cash')
  }
  assert.equal(first.transfer_instructions_json,second.transfer_instructions_json)
  assert.equal(foreign.transfer_instructions_json,null)
  await api('entity.update',{revision:(await api('business')).revision,entity,...entityTerms,processor_account_ref:'synthetic-nectar-other-account'})
  const otherRoute=await issue(customers[0],'Other processor route')
  assert.equal(otherRoute.transfer_instructions_json,null,'An invoice routed to a different processor account never receives these remit-to instructions')

  assert.equal(await pdf(originalSession.token,old.id),oldPdf,'New instructions do not rewrite an already-issued PDF')
  for(const language of ['en','es-US']) {
    const customer=await api(`customers/${customers[0]}`)
    await api('customer.update',{customer:customer.id,revision:customer.revision,name:customer.name,billing_email:customer.billing_email,language})
    const own=await session(customers[0]),other=await session(customers[1])
    const data=await (await h.raw(`/portal/data?session=${encodeURIComponent(own.token)}`)).json()
    for(const id of [first.id,second.id])assert.deepEqual(data.invoices.find(row=>row.id===id).transferInstructions,expected)
    assert.equal(data.invoices.find(row=>row.id===old.id).transferInstructions,null)
    for(const invoice of [first,second]) {
      const html=await h.page(path(own.token,invoice.id)),document=await pdf(own.token,invoice.id),overview=await h.page(path(own.token))
      for(const field of ['Synthetic Remittance Bank','Synthetic Merchant Treasury','990000123456','110000000','USD'])
        for(const text of [html,document,overview])assert.ok(text.includes(field),`Every own-customer representation contains ${field}`)
      for(const label of language==='en'?['Checking','ACH credit','US domestic wire','United States','Test mode only']:['Cuenta corriente','Crédito ACH','Transferencia nacional de EE. UU.','Estados Unidos','Solo modo de prueba']) {
        assert.ok(html.includes(label));assert.ok(document.includes(label));assert.ok(overview.includes(label))
      }
      assert.ok(!html.includes('sourceHash')&&!html.includes('synthetic-nectar-transfer-account'),'Customer projection omits internal source custody')
      assert.equal((await h.raw(path(other.token,invoice.id))).status,404)
      assert.equal((await h.raw(path(other.token,invoice.id,'pdf'))).status,404)
      if(invoice.id===first.id)await onState({label:`transfer-invoice-${language}`,path:path(own.token,invoice.id),pdfPath:path(own.token,invoice.id,'pdf'),fields:expected})
    }
    await onState({label:`transfer-portal-${language}`,path:path(own.token),fields:expected})
    assert.ok(!(await h.page(path(other.token))).includes('990000123456'))
    await api('portal.session.revoke',{session:own.id})
    assert.equal((await h.raw(path(own.token,first.id,'pdf'))).status,401)
  }
  const stale=await prepare(customers[1]),c=await api(`customers/${customers[1]}`)
  await api('customer.update',{customer:c.id,revision:c.revision,name:'Changed binding basis',billing_email:c.billing_email})
  await api('transfer.instructions.confirm',stale.confirm,409)
  const expired=await prepare(customers[1])
  instant+=16*60*1000;await h.advanceClock(new Date(instant).toISOString())
  await api('transfer.instructions.confirm',expired.confirm,403)
  await fresh();await api('transfer.instructions.confirm',expired.confirm,409)
  for(const [index,kind] of [[2,'lost'],[3,'invalid'],[4,'audit'],[7,'ambiguous']]) {
    const prepared=await prepare(customers[index])
    if(kind==='lost')edge.lose()
    if(kind==='invalid')edge.invalid(true)
    if(kind==='ambiguous')edge.ambiguous(true)
    if(kind==='audit')await h.rejectAudit('transfer.instructions.retain')
    const result=await api('transfer.instructions.confirm',prepared.confirm)
    await h.rejectAudit(null);edge.invalid(false);edge.ambiguous(false)
    assert.equal(result.status,'uncertain');assert.equal(result.instructions,null)
    const count=posts()
    await api('transfer.instructions.confirm',prepared.confirm,409)
    await api('transfer.instructions.prepare',{customer:customers[index],account_ref},409)
    assert.equal(posts(),count,'Unknown or invalid outcomes never resend')
    const issued=await issue(customers[index]);assert.equal(issued.transfer_instructions_json,null)
  }
  // A pending preparation is installation authority; erasure removes it with the remit fields.
  const pending=await prepare(customers[5]),erasedSession=await session(customers[0])
  const erasure=await api('erasure.request',{customer:customers[0]})
  await api('erasure.verify',{request:erasure.id,reason:'Independently verified synthetic identity',evidence:file('synthetic-nectar-identity.txt','Synthetic verification')})
  await api('erasure.approve',{request:erasure.id,confirm:true})
  assert.equal((await h.raw(path(erasedSession.token,first.id,'pdf'))).status,401)
  await api('transfer.instructions.confirm',review.confirm,409)
  assert.equal((await read(customers[0]))[0].instructions,null)
  assert.equal((await api(`invoices/${first.id}`)).transfer_instructions_json,'{}')
  await h.assertStorageExcludes(['990000123456','Synthetic Remittance Bank','Synthetic Merchant Treasury'])
  const erasePending=await api('erasure.request',{customer:customers[5]})
  await api('erasure.verify',{request:erasePending.id,reason:'Synthetic identity checked',evidence:file('synthetic-nectar-pending.txt','Synthetic verification')})
  await api('erasure.approve',{request:erasePending.id,confirm:true})
  await api('transfer.instructions.confirm',pending.confirm,409)
  const portablePending=await prepare(customers[6])
  assert.equal(posts(),5,'Only the supported request and four uncertain requests reached Stripe; no payment or policy POST exists')
  console.log('Transfer instruction confirmation, immutable invoice and PDF and portal parity, refusals, once-only claims, uncertainty and erasure passed')
  return {customer:customers[0],invoice:first.id,financeEmail:financeAddress,pending:portablePending.confirm,claimed:review.confirm}
}
