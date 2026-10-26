import type { Bindings } from '../auth.server'
import type { CustomerSession } from './portal-session'
import { one, insist, fingerprint } from './core'
import { customerText } from './locale'

export async function setupConsent(env: Bindings, session: CustomerSession, method: string) {
  const merchant=await one(env,'SELECT legal_name FROM nc_business WHERE singleton=1')
  insist(merchant?.legal_name,'business_identity_required',409)
  const L=customerText(session.language,session.currency)
  const wording={version:'nectar-setup-1',merchant:merchant.legal_name,language:session.language,method,
    purpose:L.t('checkout.explain'),save:L.t('checkout.consent'),default:L.t('checkout.default')}
  return {wording,hash:await fingerprint(wording)}
}
