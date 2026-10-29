import { nativeClient } from './native-client.mjs'

/** The native setup-token bootstrap declared by Nectar, followed by its real member/business setup. */
export default async function initialize({ request, origin, claim, email, returnTo }) {
  if (claim.mode !== 'setup-token') throw new Error('Nectar requires its declared native bootstrap lifecycle')
  const response = await request(new URL('/auth/bootstrap', origin).href, {
    method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ token: claim.token, displayName: 'Taylor Billing', returnTo }),
  })
  if (response.status !== 303) return response
  const cookie = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
  if (!cookie) return response
  const api = nativeClient({ request, origin, cookie })
  await api('me')
  await api('business.configure', { legal_name: 'Cedar Billing Operations', timezone: 'UTC',
    invoice_prefix: 'CED', payment_terms_days: 30, billing_email: email, currency: 'USD', address: '100 Cedar Lane' })
  const pending = await api('tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'no_tax', tax_rate: '0',
    tax_note: 'Synthetic no-tax native conformance business' })
  await api('policy.decide', { request: pending.request, decision: 'approved', confirm_single: true })
  await api('tax.review', { revision: (await api('business')).revision })
  return response
}
