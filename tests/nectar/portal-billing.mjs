import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { file } from './harness.mjs'
import { totp } from './mfa.mjs'
import { portalPaymentEdge } from './portal-payment-edge.mjs'
import { portalCustomerSignIn } from './portal-signin-helper.mjs'
import { seedPortalRecords } from './portal-sessions.mjs'

const mailbox=name=>`${name}${String.fromCharCode(64)}example.test`
let edge
export const harnessOptions=()=>{edge=portalPaymentEdge();return {stripeFetch:edge.fetch,stripeSecret:'synthetic-nectar-1'}}

export async function portalBillingFlow(h,owner,hooks={}) {
  const at='2026-10-28T09:00:00Z'
  await h.advanceClock(at)
  const factor=await h.api('mfa.totp.start',owner,{})
  await h.api('mfa.totp.confirm',owner,{factor:factor.factor,code:totp(factor.secret,Date.parse(at))})
  const records=await seedPortalRecords(h,owner),customer=records.customers[0],peer=records.customers[1],invoice=records.invoice.id
  await h.api('portal.configure',owner,{hosts:[h.origin],parents:[]})
  await hooks.state?.({name:'signin',path:'/portal/signin'})
  const request=async (external,email,extra={})=>h.raw('/portal/signin',{form:new URLSearchParams({customer:external,email}),...extra})
  const own=await h.api(`customers/${customer}`,owner),foreign=await h.api(`customers/${peer}`,owner)
  const count=h.mails.length
  const unknown=await request('synthetic-nectar-unknown',mailbox('synthetic-nectar-unknown'))
  const unknownText=await unknown.text()
  assert.equal(unknown.status,200);assert.equal(h.mails.length,count,'Unknown identity causes no outgoing message')
  assert.equal((await request(own.external_id,own.billing_email,{headers:{origin:'https://foreign.example'}})).status,403)
  const session=hooks.signIn?await hooks.signIn(own):await portalCustomerSignIn(h,owner,customer)
  assert.equal((await h.raw(session.signinPath,{form:new URLSearchParams()})).status,400,'Email proof is single use')
  const again=await request('synthetic-nectar-no-account',mailbox('synthetic-nectar-other'))
  assert.equal(await again.text(),unknownText,'Public response does not reveal whether a billing contact exists')
  const foreignSession=await portalCustomerSignIn(h,owner,peer)
  const path=(p,s=session)=>`${p}${p.includes('?')?'&':'?'}session=${encodeURIComponent(s.token)}`
  const json=async(p,options={},status=200)=>{
    const response=await h.raw(path(p),options),text=await response.text()
    assert.equal(response.status,status,`${p}: ${response.status} ${text.slice(0,250)}`)
    return status===200?JSON.parse(text):text
  }
  const profile=async(fields,status=200)=>json('/portal/profile',{body:fields},status)
  assert.equal((await h.raw('/api/nectar/me',{bearer:session.token})).status,401,'Billing contact never becomes an operator')
  assert.equal((await h.raw('/portal/profile',{cookie:owner})).status,401)
  const initial=await json('/portal/profile/data')
  assert.deepEqual([initial.name,initial.billingEmail,initial.address,initial.contacts.length],['Northwind Robotics',own.billing_email,'',0])
  await hooks.state?.({name:'portal',path:path('/portal'),session,customer,invoice})
  const address={operation:'address',revision:initial.revision,address:'48 Cedar Avenue, Sacramento, CA 95814'}
  if(hooks.profile)await hooks.profile(address);else await profile(address)
  await profile(address,409)
  assert.equal((await json('/portal/profile/data')).address,address.address)
  await profile({operation:'address',revision:(await json('/portal/profile/data')).revision,address:'Foreign override',customer:peer},400)
  const contactFields={operation:'contact.add',name:'Morgan Billing',email:mailbox('synthetic-nectar-morgan')}
  if(hooks.profile)await hooks.profile(contactFields);else await profile(contactFields)
  const contact=(await json('/portal/profile/data')).contacts.find(row=>row.email===contactFields.email)
  assert.ok(contact);assert.equal(contact.name,'Morgan Billing')
  await profile(contactFields,409)
  await hooks.state?.({name:'profile-contact',path:path('/portal/profile'),session,customer,invoice})
  const contactMail=h.mails.length
  assert.equal((await request(own.external_id,contact.email)).status,200)
  const contactLink=new URL(h.mails.slice(contactMail).find(mail=>String(mail.text).includes('/portal/signin/')).text.match(/https?:\/\/[^\s]+\/portal\/signin\/[\w-]+/)[0]).pathname
  const contactResponse=await h.raw(contactLink,{form:new URLSearchParams()})
  assert.equal(contactResponse.status,303)
  const contactSession={token:new URL(contactResponse.headers.get('location')).searchParams.get('session')}
  assert.equal((await h.raw(path('/portal/profile/data',contactSession))).status,200,'Added contact signs in through its own mailbox')
  const changed=await profile({operation:'contact.update',contact:contact.id,revision:contact.revision,name:'Morgan Accounts',email:mailbox('synthetic-nectar-updated')})
  assert.equal((await h.raw(path('/portal/profile/data',contactSession))).status,401,'Changed mailbox immediately withdraws its old session')
  assert.equal((await h.raw(contactLink,{form:new URLSearchParams()})).status,400,'A replay cannot restore withdrawn contact authority')
  await profile({operation:'contact.remove',contact:contact.id,revision:changed.revision})
  assert.deepEqual((await json('/portal/profile/data')).contacts,[])
  // Keep a realistic second billing contact in the final screen.
  await profile({...contactFields,email:mailbox('synthetic-nectar-taylor'),name:'Taylor Accounts'})
  const tax={operation:'tax.add',type:'US EIN',value:'synthetic-nectar-42'}
  if(hooks.profile)await hooks.profile(tax);else await profile(tax)
  const taxId=(await json('/portal/profile/data')).taxIds[0]
  assert.deepEqual([taxId.type,taxId.value,taxId.status],['US EIN','synthetic-nectar-42','unverified'])
  assert.equal((await h.api(`customers/${customer}`,owner)).tax_exempt,0,'A declared ID grants no tax exemption')
  await profile({operation:'tax.remove',tax:taxId.id})
  assert.deepEqual((await json('/portal/profile/data')).taxIds,[])
  await profile(tax)
  const certificate={operation:'certificate.upload',state:'CA',reference:'synthetic-nectar-certificate',valid_from:'2026-01-01',expires_on:'2027-12-31',file:file('resale.pdf','%PDF-1.4\nSynthetic exemption certificate\n%%EOF','application/pdf')}
  if(hooks.profile)await hooks.profile(certificate);else await profile(certificate)
  const cert=(await json('/portal/profile/data')).certificates[0]
  assert.deepEqual([cert.state,cert.reference,cert.status],['CA',certificate.reference,'pending'])
  assert.equal(await(await h.raw(path(`/portal/profile/certificates/${cert.id}`))).text(),'%PDF-1.4\nSynthetic exemption certificate\n%%EOF')
  assert.equal((await h.raw(path(`/portal/profile/certificates/${cert.id}`,foreignSession))).status,404)
  await profile({...certificate,state:'XX'},400)
  await profile({...certificate,file:file('bad.pdf','not a PDF','application/pdf')},400)
  const w9='%PDF-1.4\nSynthetic merchant W-9\n%%EOF'
  await h.api('portal.w9.store',owner,{file:file('merchant-w9.pdf',w9,'application/pdf'),confirm_share:true})
  assert.equal(await(await h.raw(path('/portal/profile/merchant-w9'))).text(),w9)
  assert.equal((await h.raw('/portal/profile/merchant-w9')).status,401)
  const developer={bearer:(await h.api('credential.issue',owner,{name:'Portal preparation',scopes:['prepare']})).key}
  await h.api('portal.w9.store',developer,{file:file('bad.pdf',w9),confirm_share:true},403)
  await hooks.state?.({name:'profile-complete',path:path('/portal/profile'),session,customer,invoice})
  await hooks.state?.({name:'settings-w9',path:'/app/settings',operator:true,session,customer,invoice})
  const credit=(await h.api(`invoices/${invoice}`,owner)).credits[0]
  const receipt=(await h.api(`customers/${customer}`,owner)).billingRecord.receipts[0]
  for(const [p,number,amount] of [[`/portal/credits/${credit.id}`,credit.number,'USD 25.00'],[`/portal/receipts/${receipt.payment}`,receipt.number,'USD 100.00']]) {
    const response=await h.raw(path(p)),html=await response.text()
    assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),/^attachment/)
    assert.ok(html.includes(number)&&html.includes(amount));assert.doesNotMatch(html,/PRIVATE-|INTERNAL-/)
    assert.equal((await h.raw(path(p,foreignSession))).status,404)
  }
  const pdf=await h.raw(path(`/portal/invoices/${invoice}?format=pdf`))
  assert.equal(pdf.status,200);assert.equal(pdf.headers.get('content-type'),'application/pdf')
  assert.match(await pdf.text(),/^%PDF-/)
  await h.api('collection.customer.bind',owner,{customer,account_ref:edge.account,stripe_customer_ref:edge.customer,confirm:true})
  const englishData=await json('/portal/data')
  await h.api('customer.update',owner,{customer,revision:(await h.api(`customers/${customer}`,owner)).revision,name:own.name,billing_email:own.billing_email,address:address.address,language:'es-US'})
  const spanishData=await json('/portal/data')
  assert.deepEqual(spanishData.invoices,englishData.invoices,'Spanish preserves every exact invoice figure')
  assert.match(await(await h.raw(path('/portal/profile'))).text(),/lang="es-US"/)
  await hooks.state?.({name:'profile-spanish',path:path('/portal/profile'),session,customer,invoice})
  const paymentInfo=await json(`/portal/payment?invoice=${invoice}`),consent=paymentInfo.consent
  const pay={invoice,consent_hash:consent,confirm:true}
  await json('/portal/pay',{body:{...pay,amount:'1'}},400)
  await json('/portal/pay',{body:{...pay,confirm:false}},400)
  await json('/portal/pay',{body:{...pay,consent_hash:'synthetic-nectar-invalid'}},409)
  const foreignInvoice=records.invoices.find(row=>row.customer_id===peer).id
  assert.equal((await h.raw(path('/portal/pay',foreignSession),{body:pay})).status,404)
  assert.equal((await h.raw(path(`/portal/invoices/${foreignInvoice}`))).status,404)
  assert.equal((await h.raw(path('/portal/pay'),{body:pay,headers:{origin:'https://foreign.example'}})).status,403)
  await hooks.state?.({name:'invoice-pay',path:path(`/portal/invoices/${invoice}`),session,customer,invoice})
  const started=hooks.pay?await hooks.pay(pay):await json('/portal/pay',{body:pay})
  assert.equal(started.status,'open');assert.equal(edge.calls.length,1);assert.equal(edge.calls[0].amount,17500)
  await json('/portal/pay',{body:pay});assert.equal(edge.calls.length,1,'Repeated confirmation never creates a second checkout')
  assert.equal((await h.raw(path('/portal/pay/reconcile',foreignSession),{body:{payment:started.id}})).status,404)
  const checkout=[...edge.sessions.values()][0],originalAmount=checkout.amount_total
  checkout.amount_total=1
  await json('/portal/pay/reconcile',{body:{payment:started.id}},409)
  assert.equal((await json('/portal/data')).invoices[0].balance_cents,17500,'A mismatched provider amount changes no financial facts')
  checkout.amount_total=originalAmount
  edge.complete()
  assert.equal((await json('/portal/pay/reconcile',{body:{payment:started.id}})).status,'pending')
  assert.deepEqual([...(await json('/portal/data')).invoices.map(row=>row.balance_cents)],[17500],'Processing ACH never becomes paid cash')
  await hooks.state?.({name:'payment-pending',path:path(`/portal/invoices/${invoice}`),session,customer,invoice})
  edge.settle()
  const settled=await json('/portal/pay/reconcile',{body:{payment:started.id}})
  assert.equal(settled.status,'paid')
  const paid=await h.api(`invoices/${invoice}`,owner)
  assert.deepEqual([paid.total_cents,paid.paidCents,paid.balanceCents],[30000,27500,0])
  assert.deepEqual((await json('/portal/data')).invoices.map(row=>[row.paid_cents,row.balance_cents]),[[27500,0]])
  const beforePayments=await h.api('payments',owner)
  await json('/portal/pay/reconcile',{body:{payment:started.id}})
  assert.deepEqual(await h.api('payments',owner),beforePayments,'Settlement replay adds no payment or allocation')
  assert.equal(edge.calls.length,1)
  await hooks.state?.({name:'payment-paid',path:path(`/portal/invoices/${invoice}`),session,customer,invoice})
  await h.api('portal.session.revoke',owner,{session:session.id})
  assert.equal((await h.raw(path('/portal/profile/data'))).status,401)
  assert.equal((await h.raw(path('/portal/profile'),{body:tax})).status,401)
  assert.equal((await h.raw(path('/portal/pay/reconcile'),{body:{payment:started.id}})).status,401)
  assert.equal((await h.raw(path('/portal/data',foreignSession))).status,200)
  await hooks.state?.({name:'revoked',path:path('/portal/profile'),session,customer,invoice})
  const fresh=await portalCustomerSignIn(h,owner,customer)
  const freshPath=p=>path(p,fresh)
  const secondContact=await h.raw(freshPath('/portal/profile'),{body:{operation:'contact.add',name:'Jordan Billing',email:mailbox('synthetic-nectar-jordan')}})
  assert.equal(secondContact.status,200)
  assert.equal((await h.raw(freshPath('/portal/profile'),{body:{...tax,value:'synthetic-nectar-83'}})).status,200)
  const beforeErasure=await h.api('erasures',owner)
  assert.equal((await h.raw(freshPath('/portal/privacy'),{form:new URLSearchParams({confirm:'yes',customer:peer})})).status,400)
  assert.equal((await h.raw(freshPath('/portal/privacy'),{form:new URLSearchParams({confirm:'yes'})})).status,303)
  const erasure=(await h.api('erasures',owner)).find(row=>!beforeErasure.some(old=>old.id===row.id))
  assert.equal(erasure.customer_id,customer)
  await h.api('erasure.approve',owner,{request:erasure.id,confirm:true},409)
  const verification=new URL(h.mails.findLast(mail=>String(mail.text).includes('/erase/')).text.match(/https?:\/\/[^\s]+\/erase\/[a-f0-9]+/)[0]).pathname
  assert.equal((await h.raw(verification,{form:new URLSearchParams({confirm:'yes'})})).status,200)
  const erased=await h.api('erasure.approve',owner,{request:erasure.id,confirm:true})
  for(const kind of ['nc_contacts','nc_customer_tax_ids','nc_certificates','nc_portal_signins','nc_portal_invoice_payments','nc_portal_invoice_payment_authority'])assert.ok(erased.receipt.changed.some(row=>row.kind===kind&&row.records>0),`Erasure receipt enumerates ${kind}`)
  await h.assertStorageExcludes([tax.value,'synthetic-nectar-83',contactFields.email,contactFields.name,certificate.reference,'Synthetic exemption certificate',mailbox('synthetic-nectar-taylor'),mailbox('synthetic-nectar-jordan')])
  assert.equal((await h.raw(freshPath('/portal/profile/data'))).status,401)
  assert.equal((await h.raw(fresh.signinPath,{form:new URLSearchParams()})).status,400,'Erased person cannot replay sign-in proof')
  assert.equal((await h.raw(freshPath('/portal/pay/reconcile'),{body:{payment:started.id}})).status,401,'Captured payment replay cannot recreate an erased customer')
  const retained=await h.api(`invoices/${invoice}`,owner)
  assert.deepEqual([retained.total_cents,retained.paidCents,retained.balanceCents],[30000,27500,0])
  const afterEraseMails=h.mails.length
  await request(own.external_id,own.billing_email)
  assert.equal(h.mails.length,afterEraseMails,'Erased mailbox receives no new portal credential')
  assert.equal((await h.raw(path('/portal/profile/data',foreignSession))).status,200,'Peer profile survives erasure')
  console.log('Billing-contact email sign-in, profile, documents, isolated exact ACH settlement and replay custody passed')
  return {records,session,foreignSession}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const {runIsolated}=await import('./isolated.mjs')
  await runIsolated('portal-billing','portalBillingFlow',async()=>({portalBillingFlow,harnessOptions}))
}
