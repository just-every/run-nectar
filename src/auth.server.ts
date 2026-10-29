import { createDependencies } from './modules/dependencies/index.mjs'
import { createIdpOwnerClaimHandler, createOwnerClaimHandler } from './modules/owner-claim/index.mjs'
import { firstRunResponse } from './base/setup'
import { fontDocumentResponse } from './base/font-response'
import { AuthError, createOperatorAuth, createAuthHandler, createSignInHandler, devGate, devNotFound, type AuthConfig } from './modules/operator-auth/index.mjs'
import { operatorMail } from './mail.server.mjs'
import branding from './branding.json'

// The edition's declared theme (public/rer-theme.css), as Base frames link it.
const theme = { href: '/rer-theme.css', productName: branding.name, accentColor: branding.primaryColor }

export interface Bindings {
 DB: D1Database
 /** Built browser files; hosted deploys run the Worker first (staticAssetResponse). */
 ASSETS?: Fetcher
 RER_DEPLOY_SOURCE?: string
 RER_DEPLOY_FINGERPRINT?: string
 RER_VERSION?: { id: string }
 IDENTITY_PROVIDER?: string
 AUTH_ORIGIN: string
 AUTH_LOCAL?: string
 RER_DEV_ORIGIN?: string
 /** Local runtimes only: the checkout's key gate and dev identity switch. Deploy refuses both. */
 RER_MODELS_SERVICE?: string
 RER_MODELS_KEY?: string
 RER_DEV_KEY?: string
 RER_DEV_IDENTITY?: string
 RER_DEMO?: string
 RER_OWNER_CLAIM_PUBLIC_KEYS?: string
 RER_OWNER_CLAIM_ISSUER?: string
 RER_OWNER_CLAIM_INSTALLATION_ID?: string
 RER_INSTALLATION_ID?: string
 RER_MANAGEMENT_ORIGIN?: string
 OWNER_EMAIL: string
 SESSION_SECRET: string
 /** GOV-007: seals authenticator-app secrets at rest; never the session secret. */
 MFA_KEY?: string
 /** Enterprise OIDC runtime credentials; never stored in portable records. */
 SSO_OIDC_TRANSACTION_SECRET?: string
 SSO_OIDC_SECRET?: string
 SSO_OIDC_PRIVATE_KEY?: string
 /** PORT-005: installation-held customer-session signer; excluded from archives. */
 PORTAL_KEY?: string
 SETUP_TOKEN?: string
 MAIL_PROVIDER?: 'development' | 'rer' | 'resend' | 'sendgrid' | 'cloudflare'
 MAIL_FROM?: string
 /** Owner-authorized original Stripe invoice collection; runtime secret, never archived. */
 STRIPE_BILLING_SECRET?: string
 STRIPE_SECONDARY_SECRET_KEY?: string
 /** Signature secret for observation-only card updater delivery; never archived. */
 STRIPE_WEBHOOK_SECRET?: string
 /** AR-004 bad-debt journal posting; the token is a runtime secret, never archived or stored in records. */
 QUICKBOOKS_ACCESS_TOKEN?: string
 QUICKBOOKS_ENVIRONMENT?: 'sandbox' | 'production'
 QUICKBOOKS_COMPANY_ID?: string
 MAIL_API_KEY?: string
 MAIL_RELAY_URL?: string
 MAIL_ACCOUNT_ID?: string
}

export const runtimeBindings = (env: Bindings): Bindings => env.RER_DEV_ORIGIN && env.AUTH_LOCAL === 'true' ? { ...env, AUTH_ORIGIN: env.RER_DEV_ORIGIN } : env
export const authConfig = (env: Bindings): AuthConfig => ({ dependencies: true, origin: env.AUTH_ORIGIN, local: env.AUTH_LOCAL === 'true', OWNER_EMAIL: env.OWNER_EMAIL, SESSION_SECRET: env.SESSION_SECRET, SETUP_TOKEN: env.SETUP_TOKEN, MAIL_FROM: env.MAIL_FROM, branding: { productName: branding.name, accentColor: branding.primaryColor, signInPath: '/signin', theme: theme.href } })
export function operatorAuth(env: Bindings) {
 return createOperatorAuth({ db: env.DB, config: authConfig(env), mailSender: operatorMail(env), clientIp: request => request.headers.get('CF-Connecting-IP') ?? '', hooks: {
  async beforeMagicLink({ email }) {
   return !await env.DB.prepare('SELECT 1 FROM nc_scim_users WHERE email=?').bind(email).first()
  },
  // Recheck at admission too: a link issued before enterprise authorization
  // must never create an alternate native session after the account is bound.
  async afterConfirm({ operator, session, method }) {
   const managed = await env.DB.prepare('SELECT external_id,active FROM nc_scim_users WHERE operator_id=?').bind(operator.id).first<{ external_id: string; active: number }>()
   if (!managed) return
   const provider = method === 'oidc' && await env.DB.prepare('SELECT 1 FROM oa_provider_sessions p JOIN nc_sso_config c ON c.issuer=p.issuer WHERE p.session_id=? AND p.subject=?').bind(session.id, managed.external_id).first()
   if (!managed.active || !provider) throw new AuthError('provider_required', 403)
  },
 } })
}


export async function authResponse(request: Request, original: Bindings): Promise<Response | null> {
 const env = runtimeBindings(original), url = new URL(request.url)
 if (url.pathname.startsWith('/.well-known/rer-') || url.pathname.startsWith('/auth/dependencies/')) {
  const linked = await createDependencies({ db: env.DB, origin: env.AUTH_ORIGIN, name: branding.name, provider: env.IDENTITY_PROVIDER, local: env.AUTH_LOCAL === 'true', auth: operatorAuth(env), claimOwner: token => createIdpOwnerClaimHandler({db:env.DB,authConfig:authConfig(env),clientIp:()=>request.headers.get('CF-Connecting-IP')??''})(new Request(env.AUTH_ORIGIN+'/auth/owner-claim',{method:'POST',headers:{Host:new URL(env.AUTH_ORIGIN).host,Origin:env.AUTH_ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({token})})) }).handle(request)
  if (linked) return linked
 }
 if (url.pathname === '/auth/owner-claim' && env.RER_OWNER_CLAIM_PUBLIC_KEYS) return createOwnerClaimHandler({ db: env.DB, authConfig: authConfig(env), clientIp: req => req.headers.get('CF-Connecting-IP') ?? '', issuer: env.RER_OWNER_CLAIM_ISSUER ?? '', installationId: env.RER_OWNER_CLAIM_INSTALLATION_ID ?? '', appOrigin: env.AUTH_ORIGIN, expectedEmail: env.OWNER_EMAIL, publicKeys: JSON.parse(env.RER_OWNER_CLAIM_PUBLIC_KEYS) })(request)
 if (url.pathname === '/auth/owner-claim') return createIdpOwnerClaimHandler({db:env.DB,authConfig:authConfig(env),clientIp:req=>req.headers.get('CF-Connecting-IP')??''})(request)
 // The key exchange answers only a local runtime holding RER_DEV_KEY.
 if (url.pathname === '/__dev/key') {
  const gate = devGate({ key: env.RER_DEV_KEY, origin: env.AUTH_ORIGIN, local: env.AUTH_LOCAL === 'true' })
  return gate ? await gate.exchange(request) ?? devNotFound() : devNotFound()
 }
 // The shared server-rendered sign-in page: plain forms that work before any script.
 if (url.pathname === '/signin') {
  const page = await createSignInHandler(operatorAuth(env), { defaultReturnTo: '/setup' })(request)
  if (page) return fontDocumentResponse(page)
 }
 // Provisioned identities never acquire an alternate email sign-in route.
 if (url.pathname === '/auth/magic-link' && request.method === 'POST') {
  const copy = request.clone()
  const input: any = request.headers.get('content-type')?.includes('application/json') ? await copy.json().catch(() => null) : Object.fromEntries(await copy.formData().catch(() => new FormData()))
  if (typeof input?.email === 'string' && await env.DB.prepare('SELECT 1 FROM nc_scim_users WHERE email=?').bind(input.email.trim().toLowerCase()).first()) return Response.json({error:'provider_required'},{status:403})
 }
 if (url.pathname.startsWith('/auth/')) return fontDocumentResponse(await createAuthHandler(operatorAuth(env))(request))
 if (url.pathname === '/setup' || url.pathname === '/app' || url.pathname.startsWith('/app/')) {
  const setup = await firstRunResponse(request, env, operatorAuth(env), { theme })
  if (setup) return setup
 }
 return null
}
