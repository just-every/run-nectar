import { createMailSender } from './modules/mail/index.mjs'

const mailOff = { send: async () => ({ status: 'rejected', provider: 'none', providerMessageId: null, code: 'mail_off' }) }

export function operatorMail(env) {
 if (env.MAIL_PROVIDER === 'none') return mailOff
 // Demos and local development send nothing: Base's development provider
 // validates each message and suppresses it, and auth accepts that there.
 if (env.RER_DEMO === '1' || (env.MAIL_PROVIDER === 'development' && env.AUTH_LOCAL === 'true')) return createMailSender({ provider: 'development', mode: 'development' })
 if (!env.MAIL_PROVIDER || env.MAIL_PROVIDER === 'development') return undefined
 // Construct only on a send: first-owner setup never depends on mail credentials.
 return { send: message => createMailSender({ provider: env.MAIL_PROVIDER, mode: 'production', apiKey: env.MAIL_API_KEY, ...(env.MAIL_PROVIDER === 'rer' ? { relayUrl: env.MAIL_RELAY_URL } : {}), ...(env.MAIL_PROVIDER === 'cloudflare' ? { accountId: env.MAIL_ACCOUNT_ID } : {}) }).send(message) }
}
