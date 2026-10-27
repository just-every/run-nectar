// Outside push Verify: the injector supplies MAIL_API_KEY from held SendGrid.
// Actual provider acceptance is distinct from mailbox delivery or settlement.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { harness } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { totp } from './mfa.mjs'
const instant=Date.parse('2026-10-22T10:00:00Z')
const receipt={journey:'DUN-003 SendGrid recorded-payment notice',head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()}
const h=await harness({localTime:new Date(instant).toISOString()})
let sends=0
try {
 assert.ok(process.env.MAIL_API_KEY,'held_mail_key_required')
 await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})
 const owner=await h.signIn(h.vars.OWNER_EMAIL)
 await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
 const api=(p,b,s)=>h.api(p,owner,b,s)
 await api('business.configure',{legal_name:'Synthetic Nectar notice merchant',timezone:'UTC',invoice_prefix:'NOTICE',payment_terms_days:30})
 await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Synthetic notice journey'})
 await api('tax.review',{revision:(await api('business')).revision})
 const factor=await api('mfa.totp.start',{})
 await api('mfa.totp.confirm',{factor:factor.factor,code:totp(factor.secret,instant)})
 const customer=await api('customer.create',{external_id:'synthetic-nectar-931',name:'Synthetic Nectar notice customer',billing_email:'fleet@runeditrun.com'})
 const charge=await api('charge.add',{customer:customer.id,amount:'12',description:'Synthetic notice proof',effective_date:'2026-10-22',taxable:false})
 const invoice=await api('invoice.manual',{customer:customer.id,charges:[charge.charge],service_date:'2026-10-22'})
 await api('invoice.approve',{invoice:invoice.id,acknowledge:true})
 await api('invoice.finalise',{invoice:invoice.id,issue_date:'2026-10-22'})
 const payment=await api('payment.record',{customer:customer.id,amount:'12',received_on:'2026-10-22',method:'bank_transfer',reference:'synthetic-nectar-931'})
 await api('payment.allocate',{payment:payment.payment,invoice:invoice.id,amount:'12'})
 await h.configureMail({provider:'sendgrid',apiKey:process.env.MAIL_API_KEY,from:'fleet@runeditrun.com'},async request=>{
  assert.equal(request.url,'https://api.sendgrid.com/v3/mail/send')
  const payload=await request.clone().json()
  assert.deepEqual(payload.personalizations.flatMap(p=>p.to.map(r=>r.email)),['fleet@runeditrun.com'])
  sends++
  const response=await fetch(request.url,{method:request.method,headers:request.headers,body:await request.arrayBuffer(),signal:AbortSignal.timeout(20000)})
  receipt.httpStatus=response.status
  return response
 })
 await api('billing.notice.configure',{kind:'payment_receipt',sender:'nectar',revision:0,language:'en',confirm:true})
 const notice=await api('billing.notice.prepare',{kind:'payment_receipt',invoice:invoice.id,confirm:true})
 assert.equal(notice.amountCents,1200);assert.match(notice.body,/USD 12\.00/);assert.equal(sends,0)
 const sent=await api('billing.notice.send',{notice:notice.id,basis_hash:notice.basis,confirm:true})
 receipt.status=sent.status;receipt.providerRef=sent.provider
 assert.equal(sent.status,'accepted');assert.ok(sent.provider);assert.equal(sends,1)
 await api('billing.notice.send',{notice:notice.id,basis_hash:notice.basis,confirm:true},409)
 assert.equal(sends,1);assert.equal((await api(`invoices/${invoice.id}`)).paidCents,1200)
 receipt.outcome='passed'
} catch(error) {
 receipt.outcome='failed';receipt.error=error?.code??error?.name??'notice_proof_failed';process.exitCode=1
} finally {await h.close();console.log(JSON.stringify({...receipt,sends}))}
