import assert from 'node:assert/strict'
import { totp } from './mfa.mjs'

// Invoked inside paymentRetriesFlow so notice assertions use its real failures,
// processor recovery and independently reconciled allocation ledger.
export async function billingNoticeAssertions(h,owner,invoice,{paid=false}={}) {
 const api=(p,b,s)=>h.api(p,owner,b,s),kind=paid?'payment_receipt':'payment_failed'
 const configure=async(kind,sender,extra={})=>{
  const row=(await api('billing-notices')).settings.find(s=>s.kind===kind)
  return api('billing.notice.configure',{kind,sender,revision:row.revision,language:'en',confirm:true,...extra})
 }
 const prepare=(id=invoice,status=200)=>api('billing.notice.prepare',{kind,invoice:id,confirm:true},status)
 const send=(n,status=200)=>api('billing.notice.send',{notice:n.id,basis_hash:n.basis,confirm:true},status)
 const original=await api('recovery')
 await prepare(invoice,409)
 if(!paid) {
  const settings=(await api('billing-notices')).settings
  assert.deepEqual(settings.map(s=>s.kind).sort(),['authentication_required','payment_failed','payment_method_required','payment_receipt','trial_ending','upcoming_renewal'])
  assert.ok(settings.every(s=>s.sender==='off'))
  await configure(kind,'nectar',{subject:'Payment for {invoice}',body:'{merchant}: {invoice}, {amount}, {date}'})
 } else await configure(kind,'nectar')
 const count=h.mails.length,n=await prepare()
 assert.equal(h.mails.length,count,'Preparation never sends')
 assert.equal(n.amountCents,10000);assert.equal(n.language,'en')
 assert.match(n.body,/USD 100\.00/);assert.equal(n.recipient,'retry-1@example.test')
 const source=await api(`invoices/${invoice}`)
 assert.ok(n.body.includes(source.number))
 await api('billing.notice.send',{notice:n.id,basis_hash:'synthetic-nectar-wrong-basis',confirm:true},409)
 assert.equal(h.mails.length,count)
 // A setting changed between prepare and claim refuses the frozen preparation.
 await configure(kind,'processor')
 await send(n,409);assert.equal(h.mails.length,count)
 await configure(kind,'nectar',!paid?{subject:'Payment for {invoice}',body:'{merchant}: {invoice}, {amount}, {date}'}:{})
 await send(n,409,'A later settings revision cannot revive a stale prepared message')
 // Stale reservations cannot be replaced to bypass no-retry custody.
 await prepare(invoice,409)
 assert.deepEqual(await api('recovery'),original,'Preparing and refusing notices never changes recovery facts')
 return {configure,prepare,send}
}

// Use another invoice for the successful once-only provider claim.
export async function sendBillingNoticeAssertions(h,owner,invoice,{paid=false,language='en',recipient='retry-1@example.test',outcome='accepted'}={}) {
 const api=(p,b,s)=>h.api(p,owner,b,s),kind=paid?'payment_receipt':'payment_failed'
 let row=(await api('billing-notices')).settings.find(s=>s.kind===kind)
 await api('billing.notice.configure',{kind,sender:'nectar',revision:row.revision,language:'en',confirm:true})
 const n=await api('billing.notice.prepare',{kind,invoice,confirm:true}),before=h.mails.length
 assert.equal(n.language,language);assert.equal(n.recipient,recipient);assert.equal(n.amountCents,10000);assert.match(n.body,/USD 100\.00/)
 if(language==='es-US')assert.match(n.body,/Falló el pago/)
 if(paid) {
  const failed=(await api('billing-notices')).settings.find(s=>s.kind==='payment_failed')
  await api('billing.notice.configure',{kind:'payment_failed',sender:'off',revision:failed.revision,language:'en',confirm:true})
 }
 if(outcome==='rejected')h.mailResponses.push({to:recipient,status:422,body:{message:'Synthetic refusal'}})
 if(outcome==='uncertain')h.mailResponses.push({to:recipient,status:200,body:{}})

 const send=()=>h.raw('/api/nectar/billing.notice.send',{cookie:owner,body:{notice:n.id,basis_hash:n.basis,confirm:true}})
 const responses=await Promise.all([send(),send()])
 assert.deepEqual(responses.map(r=>r.status).sort(),[200,409])
 assert.equal((await responses.find(r=>r.status===200).json()).status,outcome)
 assert.equal(h.mails.length,before+1)
 const mail=h.mails.at(-1)
 assert.equal(mail.subject,n.subject);assert.equal(mail.text,n.body);assert.deepEqual(mail.to,[n.recipient])
 assert.ok(mail.html.includes(n.body.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')))
 await api('billing.notice.prepare',{kind,invoice,confirm:true},409)
 await api('billing.notice.send',{notice:n.id,basis_hash:n.basis,confirm:true},409)
 const delivery=(await api('billing-notices')).deliveries.find(d=>d.id===n.id)
 assert.equal(delivery.subject,n.subject);assert.equal(delivery.body,n.body)
 assert.equal(delivery.status,outcome);assert.equal(!!delivery.provider_ref,outcome==='accepted');assert.ok(delivery.claimed_at)
 const audit=await api('audit')
 assert.equal(audit.filter(e=>e.subject===n.id&&e.action==='billing.notice.claim').length,1)
 assert.equal(audit.filter(e=>e.subject===n.id&&e.action==='billing.notice.outcome').length,1)
 return {notice:n,html:mail.html,kind,outcome,language}
}


export async function billingNoticeCustodyAssertions(h,owner,{invoice,customer,refresh,instant}) {
 const api=(p,b,s)=>h.api(p,owner,b,s)
 await refresh()
 const note=await api('billing.notice.prepare',{kind:'payment_failed',invoice,confirm:true}),before=h.mails.length
 await h.advanceClock(new Date(instant+15*60000+1).toISOString())
 await api('billing.notice.send',{notice:note.id,basis_hash:note.basis,confirm:true},403)
 assert.equal(h.mails.length,before,'Expired owner factors cannot send')
 // A new factor cannot extend the already frozen message deadline.
 await refresh(instant+15*60000+1)
 await api('billing.notice.send',{notice:note.id,basis_hash:note.basis,confirm:true},409)
 const request=await api('erasure.request',{customer})
 await api('erasure.verify',{request:request.id,reason:'Independently verified synthetic identity',evidence:{filename:'notice-identity.txt',base64:Buffer.from('Synthetic verified notice identity').toString('base64'),type:'text/plain'}})
 const erased=await api('erasure.approve',{request:request.id,confirm:true})
 for(const kind of ['nc_billing_notice_authority','nc_billing_notices'])assert.ok(erased.receipt.changed.some(r=>r.kind===kind&&r.records>0))
 assert.equal((await api('billing-notices')).deliveries.some(d=>d.customer_id===customer),false)
 await api('billing.notice.send',{notice:note.id,basis_hash:note.basis,confirm:true},409)
 await api('billing.notice.prepare',{kind:'payment_failed',invoice,confirm:true},409)
 assert.equal(h.mails.filter(m=>m.text===note.body).length,0,'Erasure never resumes the unsent notice')
}

// Contrast every frozen external basis through the existing invoice commands.
export async function billingNoticeBasisAssertions(h,owner,create) {
 const api=(p,b,s)=>h.api(p,owner,b,s)
 const other=await api('access.give',{email:'synthetic-nectar-notice-support@example.test',name:'Synthetic notice support',role:'support'})
 const support=await h.signIn(other.email??'synthetic-nectar-notice-support@example.test',{requested:true})
 const supportFactor=await h.api('mfa.totp.start',support,{})
 await h.api('mfa.totp.confirm',support,{factor:supportFactor.factor,code:totp(supportFactor.secret,Date.parse(h.vars.NECTAR_LOCAL_TIME))})
 const setting=(await api('billing-notices')).settings.find(s=>s.kind==='payment_failed')
 await h.api('billing.notice.configure',support,{kind:'payment_failed',sender:'nectar',revision:setting.revision,language:'en',confirm:true},403)
 const mail={provider:h.vars.MAIL_PROVIDER,apiKey:h.vars.MAIL_API_KEY,from:h.vars.MAIL_FROM}
 for(const change of ['recipient','language','revision','mail-sender','mail-credential']) {
  const invoice=await create(),source=await api(`invoices/${invoice.id}`)
  const customer=await api(`customers/${source.customer_id}`)
  const n=await api('billing.notice.prepare',{kind:'payment_failed',invoice:invoice.id,confirm:true})
  const before=h.mails.length,recovery=await api('recovery')
  await h.api('billing.notice.prepare',support,{kind:'payment_failed',invoice:invoice.id,confirm:true},403)
  await h.api('billing.notice.send',support,{notice:n.id,basis_hash:n.basis,confirm:true},403)
  await h.api('billing.notice.send',undefined,{notice:n.id,basis_hash:n.basis,confirm:true},401)
  await api('billing.notice.send',{notice:n.id,basis_hash:n.basis,confirm:true,recipient:'synthetic-nectar-substitute@example.test'},400)
  if(change.startsWith('mail-'))await h.configureMail({...mail,...(change==='mail-sender'?{from:'synthetic-nectar-sender@example.test'}:{apiKey:'synthetic-nectar-rotated'})})
  else await api('customer.update',{customer:customer.id,revision:customer.revision,name:customer.name,billing_email:change==='recipient'?'synthetic-nectar-revised@example.test':customer.billing_email,language:change==='language'?'es-US':customer.language})
  const refused=await api('billing.notice.send',{notice:n.id,basis_hash:n.basis,confirm:true},409)
  assert.equal(refused.error,'notice_source_changed',change+' invalidates the frozen notice')
  await api('billing.notice.prepare',{kind:'payment_failed',invoice:invoice.id,confirm:true},409)
  assert.equal(h.mails.length,before,change+' cannot submit mail')
  assert.deepEqual(await api('recovery'),recovery,change+' cannot change cash or recovery attribution')
  const saved=(await api('billing-notices')).deliveries.find(d=>d.id===n.id)
  assert.equal(saved.status,'prepared');assert.equal(saved.claimed_at,null)
  if(change.startsWith('mail-'))await h.configureMail(mail)
  else {
   const updated=await api(`customers/${customer.id}`)
   await api('customer.update',{customer:customer.id,revision:updated.revision,name:customer.name,billing_email:customer.billing_email,language:customer.language})
  }
 }
}
