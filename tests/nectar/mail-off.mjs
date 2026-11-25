import assert from 'node:assert/strict'
import { harness } from './harness.mjs'

const h = await harness({ settings: {
  MAIL_PROVIDER: 'none', MAIL_FROM: undefined, MAIL_API_KEY: undefined,
} })

try {
  const claim = await h.raw('/auth/bootstrap', { body: { token: h.vars.SETUP_TOKEN, displayName: 'Taylor Morgan' } })
  assert.equal(claim.status, 303, claim.status === 303 ? undefined : await claim.text())
  for (const email of [h.vars.OWNER_EMAIL, 'unknown@example.test']) {
    const emailLink = await h.raw('/auth/magic-link', { body: { email } })
    assert.equal(emailLink.status, 503)
    assert.deepEqual(await emailLink.json(), { error: 'mail_off' })
  }

  const token = await h.mintOwnerSignIn()
  assert.equal((await h.raw(`/auth/owner-signin?token=${token}`)).status, 200)
  const signedIn = await h.raw('/auth/owner-signin', { body: { token } })
  assert.equal(signedIn.status, 303)
  const cookie = signedIn.headers.getSetCookie().map(line => line.split(';')[0]).join('; ')
  const session = await h.raw('/auth/session', { cookie })
  assert.equal(session.status, 200)
  assert.equal((await session.json()).operator.email, h.vars.OWNER_EMAIL)
  assert.equal((await h.raw('/auth/owner-signin', { body: { token } })).status, 400)
  assert.equal(h.mails.length, 0)
  console.log('Mail-off owner sign-in passed')
} finally {
  await h.close()
}
