// Live SendGrid acceptance for a frozen warning; mailbox delivery and a full
// renewal cycle are separate evidence. Held names are injected by the caller.
import {execFileSync} from 'node:child_process'
import {stripeSandbox,check,safeError} from './stripe-sandbox-client.mjs'
import {harness} from './harness.mjs'
import {applyPolicy} from './policy-helper.mjs'
import {publishPrice} from './price-helper.mjs'
import {totp} from './mfa.mjs'
const stripe=stripeSandbox(process.env.STRIPE_SECRET_KEY),instant=Math.floor(Date.now()/1000)*1000
const day=new Date(instant).toISOString().slice(0,10),renewal=new Date(instant+14*86400000)
const start=new Date(renewal);start.setUTCMonth(start.getUTCMonth()-1)
const startDay=start.toISOString().slice(0,10),renewalDay=renewal.toISOString().slice(0,10)
const result={journey:'PAY-005 real SendGrid expiry-warning acceptance',head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),outcome:'running',cleanup:false}
let h,customer,phase='provider-fixtures'
try {
 check(process.env.MAIL_API_KEY&&process.env.MAIL_FROM&&process.env.TEST_MAIL_TO,'held_mail_bindings_required')
 const account=await stripe.request('GET','/v1/account')
 customer=await stripe.request('POST','/v1/customers',{name:'Synthetic Nectar expiry customer','metadata[nectar_run]':stripe.run})
 const card=await stripe.request('POST','/v1/payment_methods',{type:'card','card[token]':'tok_visa'})
 await stripe.request('POST',`/v1/payment_methods/${card.id}/attach`,{customer:customer.id})
 // The card expires at the end of the month before the actual renewal month.
 const expiry=new Date(Date.UTC(renewal.getUTCFullYear(),renewal.getUTCMonth(),0))
 await stripe.request('POST',`/v1/payment_methods/${card.id}`,{'card[exp_month]':expiry.getUTCMonth()+1,'card[exp_year]':expiry.getUTCFullYear()})
 await stripe.request('POST',`/v1/customers/${customer.id}`,{'invoice_settings[default_payment_method]':card.id})
 h=await harness({localTime:new Date(instant).toISOString(),stripeSecret:process.env.STRIPE_SECRET_KEY,stripeFetch:stripe.forward})
 await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})
 const owner=await h.signIn(h.vars.OWNER_EMAIL)
 await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
 const api=(path,body,status)=>h.api(path,owner,body,status)
 await api('business.configure',{legal_name:'Synthetic Nectar expiry merchant',timezone:'UTC',invoice_prefix:'EXP',payment_terms_days:30})
 await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Reviewed expiry mail journey'})
 await api('tax.review',{revision:(await api('business')).revision})
 const factor=await api('mfa.totp.start',{});await api('mfa.totp.confirm',{factor:factor.factor,code:totp(factor.secret,instant)})
 await api('portal.configure',{hosts:[h.origin],parents:[]})
 const product=await api('product.create',{code:'synthetic-nectar-878',name:'Synthetic expiry service'})
 const price=await publishPrice(h,owner,{product:product.id,kind:'flat',unit_amount:'12',taxable:false})
 const native=await api('customer.create',{external_id:'synthetic-nectar-878',name:'Synthetic Nectar expiry customer',billing_email:process.env.TEST_MAIL_TO})
 const subscription=await api('subscription.create',{customer:native.id,start_date:startDay,anchor_day:start.getUTCDate(),price:[price.id]})
 const detail=await api(`subscriptions/${subscription.id}`)
 const term=await api('term.prepare',{subscription:subscription.id,revision:detail.revision,term_start:startDay,months:1,auto_renew:true,notice_days:1,uplift_percent:'0'})
 await api('term.decide',{term:term.term,decision:'approved',confirm_single:true})
 const binding=await api('collection.customer.bind',{customer:native.id,account_ref:account.id,stripe_customer_ref:customer.id,confirm:true})
 const setup=await api('checkout.setup.prepare',{customer:native.id,binding:binding.id,method:'card',confirm:true})
 let sends=0
 await h.configureMail({provider:'sendgrid',apiKey:process.env.MAIL_API_KEY,from:process.env.MAIL_FROM},async request=>{
  check(request.url==='https://api.sendgrid.com/v3/mail/send'&&request.method==='POST','unexpected_mail_provider_request')
  check(request.headers.get('authorization')===`Bearer ${process.env.MAIL_API_KEY}`,'mail_provider_binding_mismatch')
  const body=await request.clone().json()
  check(body.personalizations.length===1&&body.personalizations[0].to.length===1&&body.personalizations[0].to[0].email===process.env.TEST_MAIL_TO,'mail_recipient_changed')
  sends++
  return fetch(request.url,{method:'POST',headers:request.headers,body:await request.arrayBuffer(),signal:AbortSignal.timeout(20000)})
 })
 phase='prepare'
 const notice=await api('card.expiry.prepare',{customer:native.id,subscription:subscription.id,setup:setup.id,confirm:true})
 check(notice.dueDate===day&&notice.renewalDate===renewalDay&&sends===0,'expiry_notice_date_or_authority_mismatch')
 const link=new URL(notice.preview.text.match(/https?:\/\/[^\s]+\/portal\/payment-methods\?session=[^\s]+/)[0])
 check((await h.raw(link.pathname+link.search)).status===200,'actual_notice_link_does_not_open_setup')
 phase='send'
 const sent=await api('card.expiry.send',{notice:notice.id,basis_hash:notice.basis,confirm:true})
 check(sent.status==='accepted'&&sent.providerRef&&sends===1,'sendgrid_did_not_accept_expiry_notice')
 const replay=await api('card.expiry.send',{notice:notice.id,basis_hash:notice.basis,confirm:true})
 check(replay.replayed&&sends===1,'expiry_notice_was_sent_twice')
 result.outcome='passed';result.provider='sendgrid';result.providerMessageId=sent.providerRef;result.dueDate=day;result.renewalDate=renewalDay;result.notice=notice.id;result.sends=sends;result.updateLinkOpened=true
} catch(error) {result.outcome='failed';result.phase=phase;result.error=safeError(error);process.exitCode=1}
finally {
 await h?.close()
 if(customer){try{result.cleanup=(await stripe.request('DELETE',`/v1/customers/${customer.id}`)).deleted===true}catch{}}
 if(!result.cleanup){result.outcome='failed';process.exitCode=1}
 console.log(JSON.stringify({...result,requests:stripe.requests}))
}
