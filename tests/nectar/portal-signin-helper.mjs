import assert from 'node:assert/strict'

export async function portalCustomerSignIn(h,owner,customer) {
  const record=await h.api(`customers/${customer}`,owner),before=h.mails.length
  assert.equal((await h.raw('/portal/signin',{form:new URLSearchParams({customer:record.external_id,email:record.billing_email})})).status,200)
  const mail=h.mails.slice(before).find(message=>String(message.text).includes('/portal/signin/'))
  assert.ok(mail,'A current billing mailbox receives its one-purpose sign-in link')
  assert.deepEqual(mail.to,[record.billing_email])
  const path=new URL(mail.text.match(/https?:\/\/[^\s]+\/portal\/signin\/[A-Za-z0-9_-]+/)[0]).pathname
  assert.equal((await h.raw(path)).status,200,'Reading the emailed link asks for confirmation')
  const response=await h.raw(path,{form:new URLSearchParams()})
  assert.equal(response.status,303,'Confirming the emailed link signs in')
  const url=response.headers.get('location'),token=new URL(url).searchParams.get('session')
  const claims=JSON.parse(Buffer.from(token.split('.')[0],'base64url'))
  return {id:claims.jti,token,url,expiresAt:claims.exp,signinPath:path}
}
