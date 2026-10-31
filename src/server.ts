import { runScheduledJobs } from './nectar/job-runs'
import { processorWebhook } from './nectar/processor-http'
import { escalateProcessorCash } from './nectar/processor-cash-queue'
import { observeSubscriptionStates } from './nectar/subscription-states'
import { retryMethodRecoveryResponse } from './nectar/retry-method-http'
import { cardLifecycleWebhook } from './nectar/card-lifecycle-webhook'
import { samlResponse } from './nectar/saml'
import { scimResponse } from './nectar/scim'
import { expirePaymentLinkAttempts } from './nectar/payment-links-expiry'
import { paymentLinksResponse } from './nectar/payment-links-http'
import { runPaymentRetries } from './nectar/retry-jobs'
import { runAutomaticCollections } from './nectar/automatic-collection-jobs'
import { automaticCollectionResponse } from './nectar/automatic-collection-http'
import { runInvoiceAutomation } from './nectar/invoice-automation'
import { deliverPendingPrepaidRefundNotices } from './nectar/prepaid-refund-mail'
import { dispatchWebhooks } from './nectar/webhooks'
import { runTrials } from './nectar/trials'
import { runPrepaidSettlement } from './nectar/prepaid-jobs'
import { deliverPendingUsageCorrectionMail } from './nectar/usage-disposition-mail'
import { portalResponse } from './nectar/portal-http'
import { removeExpiredFinancialRecords } from './nectar/erasure-purge'
import { erasurePublic } from './nectar/erasure-public'
import { runCadences } from './nectar/cadence-scheduler'
import { runAssurance } from './nectar/assurance-schedule'
import { runWinbacks } from './nectar/retention-winback'
import { retentionPublic } from './nectar/retention-public'
import { runRenewals } from './nectar/renewal-jobs'
import { renewalPublic } from './nectar/renewal-public'
import { deliverPendingCorrectionMail } from './nectar/credit-correction-mail'
import { deliverPendingDraftCorrectionMail } from './nectar/draft-correction-mail'
import { sendScheduledReports } from './nectar/report-mail'
import { withDemo } from './modules/demo/index.mjs'
import { seedDemo } from './demo'
import start from '@tanstack/react-start/server-entry'
import { Hono } from 'hono'
import { dispatch } from './base/dispatch'
import { staticAssetResponse } from './base/static-assets'
import { deploymentHealth } from './base/deployment-health'
import { lobbyResponse } from './base/lobby'
import { setupStateResponse } from './base/setup-state'
import { authResponse, runtimeBindings, type Bindings } from './auth.server'
import { identity } from './identity'
import { sendCertificateReminders } from './nectar/certificate-reminders'
import { deliverPendingAlerts } from './nectar/notification-mail'
import { nectarResponse } from './nectar/http'

const api = new Hono<{ Bindings: Bindings }>()
api.get('/health', (context) => context.json({ status: 'ok', ...deploymentHealth(context.env) }))

// Start documents keep their own cache policy and add no-transform, so no proxy
// rewrites the HTML React hydrates (Cloudflare's email address obfuscation
// honours it; src/base/hydration/README.md).
function noTransform(response: Response): Response {
  const headers = new Headers(response.headers), policy = headers.get('cache-control')
  headers.set('cache-control', policy ? `${policy}, no-transform` : 'no-transform')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

export default withDemo({
  async scheduled(controller, env) {
    await runScheduledJobs(runtimeBindings(env), controller, [
      { name: 'subscription-states-before', run: () => observeSubscriptionStates(runtimeBindings(env)) },
      { name: 'webhooks', run: () => dispatchWebhooks(runtimeBindings(env)) },
      { name: 'payment-link-expiry', run: () => expirePaymentLinkAttempts(runtimeBindings(env)) },
      { name: 'automatic-collections', run: () => runAutomaticCollections(runtimeBindings(env)) },
      { name: 'payment-retries', run: () => runPaymentRetries(runtimeBindings(env)) },
      { name: 'invoice-automation', run: () => runInvoiceAutomation(runtimeBindings(env),controller.scheduledTime) },
      { name: 'subscription-states-after-invoices', run: () => observeSubscriptionStates(runtimeBindings(env)) },
      ...(controller.cron === '* * * * *' ? [] : [
        { name: 'financial-retention', run: () => removeExpiredFinancialRecords(runtimeBindings(env)) },
        { name: 'processor-cash-escalation', run: () => escalateProcessorCash(runtimeBindings(env),controller.scheduledTime) },
        { name: 'prepaid-settlement', run: () => runPrepaidSettlement(runtimeBindings(env)) },
        { name: 'cadences', run: () => runCadences(runtimeBindings(env),controller.scheduledTime) },
        { name: 'trials', run: () => runTrials(runtimeBindings(env),controller.scheduledTime) },
        { name: 'renewals', run: () => runRenewals(runtimeBindings(env),controller.scheduledTime) },
        { name: 'winbacks', run: () => runWinbacks(runtimeBindings(env),controller.scheduledTime) },
        { name: 'certificate-reminders', run: () => sendCertificateReminders(env, controller.scheduledTime) },
        { name: 'alerts', run: () => deliverPendingAlerts(runtimeBindings(env)) },
        { name: 'scheduled-reports', run: () => sendScheduledReports(runtimeBindings(env),controller.scheduledTime) },
        { name: 'correction-mail', run: () => deliverPendingCorrectionMail(runtimeBindings(env)) },
        { name: 'usage-correction-mail', run: () => deliverPendingUsageCorrectionMail(runtimeBindings(env)) },
        { name: 'draft-correction-mail', run: () => deliverPendingDraftCorrectionMail(runtimeBindings(env)) },
        { name: 'prepaid-refund-notices', run: () => deliverPendingPrepaidRefundNotices(runtimeBindings(env)) },
        { name: 'assurance', run: () => runAssurance(runtimeBindings(env),controller.scheduledTime) },
        { name: 'subscription-states-final', run: () => observeSubscriptionStates(runtimeBindings(env)) },
      ]),
    ])
  },
  async fetch(request, env, execution) {
    const paymentEvent=await processorWebhook(request,runtimeBindings(env))
    if(paymentEvent)return paymentEvent
    const cardEvent=await cardLifecycleWebhook(request,runtimeBindings(env))
    if(cardEvent)return cardEvent
    const enterprise = await samlResponse(request, runtimeBindings(env)) ?? await scimResponse(request, runtimeBindings(env))
    if (enterprise) return enterprise
    const asset = await staticAssetResponse(request, env)
    if (asset) return asset
    const paymentLink=await paymentLinksResponse(request,runtimeBindings(env))
    if(paymentLink)return paymentLink
    const recovery=await retryMethodRecoveryResponse(request,runtimeBindings(env))
    if(recovery)return recovery
    const automatic=await automaticCollectionResponse(request,runtimeBindings(env))
    if(automatic)return automatic
    const portal = await portalResponse(request, runtimeBindings(env))
    if (portal) return portal
    const auth = await authResponse(request, env)
    if (auth) return auth
    const erasure=await erasurePublic(request,runtimeBindings(env))
    if(erasure)return erasure
    const returned=await retentionPublic(request,runtimeBindings(env))
    if(returned)return returned
    const renewal=await renewalPublic(request,runtimeBindings(env))
    if(renewal)return renewal
    const nectar = await nectarResponse(request, env)
    if (nectar) return nectar
    // The installed variant: the Lobby at / and the public claim state it reads.
    // Local dev serves the saved origin's data at its own port (RER_DEV_ORIGIN).
    const state = await setupStateResponse(request, runtimeBindings(env))
    if (state) return state
    const lobby = await lobbyResponse(request, runtimeBindings(env), identity)
    if (lobby) return lobby
    return dispatch(request, () => api.fetch(request, env, execution), async () => noTransform(await start.fetch(request)))
  },
} satisfies ExportedHandler<Bindings>, { seed: seedDemo })
