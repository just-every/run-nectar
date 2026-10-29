import { previewPlaidRemittances, confirmPlaidRemittances } from './plaid-remittances'
import { preparePortalChangePolicy } from './portal-change-policy'
import { uploadRemittances, previewRemittance, confirmRemittance, previewRemittanceAllocation, allocateRemittance } from './remittances'
import { consumeProcessorEvent } from './processor-events'
import { allocateProcessorCash } from './processor-cash-queue'
import { prepareImportedCashTakeover, confirmImportedCashTakeover } from './processor-cash-imported'
import { previewProcessorCashReturn, prepareProcessorCashReturn, executeProcessorCashReturn, reconcileProcessorCashReturn } from './processor-cash-return'
import { prepareInvoiceRefund, executeInvoiceRefund, reconcileInvoiceRefund } from './invoice-refunds'
import { previewInvoiceRefund } from './invoice-refund-preview'
import { prepareInvoiceVoid, voidInvoice } from './invoice-voids'
import { createDunningPolicy, enrollDunning } from './dunning-policy'
import { prepareDunningMail, sendDunningMail } from './dunning-mail'
import { endDunning, revokeDunning } from './dunning'
import { assignRetrySegment } from './retry-segments'
import { prepareRetryMethodRecovery,decideRetryMethodRecovery } from './retry-method-recovery'
import { recordRetryChurn } from './retry-churn'
import { prepareCardExpiryNotice, sendCardExpiryNotice } from './card-expiry-notices'
import { consumeCardLifecycleEvent } from './card-lifecycle'
import { preparePortalMethodAction } from './portal-method-actions'
import { configureSso } from './sso-config'
import { approvePaymentLink } from './payment-links-approval'
import { createPaymentLink,deactivatePaymentLink,activatePaymentLink } from './payment-links'
import { configureRetryPolicy } from './retry-policy'
import { prepareAutomaticCollection,decideAutomaticCollection,revokeAutomaticCollection } from './automatic-collection'
import { checkAutomaticCollection,consumeAutomaticEvent } from './automatic-collection-events'
import { prepareHostedSetup } from './hosted-setup'
import { scanAssurance,assignAssurance,approveAssurance,recheckAssurance } from './assurance'
import { prepareInvoiceAutomation,decideInvoiceAutomation,runInvoiceAutomationDoor } from './invoice-automation'
import { prepareShadowAppChange,confirmShadowAppChange,reconcileShadowAppChange,shadowInvoicePreview,appInvoicePreview } from './shadow-app'
import { consumeStripeWebhookEvent } from './webhook-stripe'
import { recordAchPaymentEvidence } from './ach-payment-evidence'
import { refreshCustomerPaymentMethods } from './customer-payment-methods'
import { recordDailyRate } from './currency-rates'
import { prepareTrialCollection,confirmTrialCollection,approveTrialCollection,revokeTrialCollection } from './trial-collection'
import { configureRefundNotices } from './prepaid-refund-mail'
import { requestSupportPrepaidRefund } from './prepaid-refund-intake'
import { preparePlanChange,decidePlanChange,preparePlanChangeCredit } from './plan-changes'
import { setHierarchy,prepareConsolidation,recordHierarchyCommitment } from './hierarchies'
import { registerWebhook,rotateWebhook,disableWebhook,replayWebhook,dispatchWebhookDoor } from './webhooks'
import { issueWriteOff, prepareWriteOff, approveWriteOff, recoverWriteOff } from './write-offs'
import { postPendingLedger } from './ledger-postings'
import { closePeriod } from './period-close'
import { applyBalance, approveBalanceRequest, grantGoodwill, prepareBalanceRequest, returnBalance } from './balance'
import { createCoupon, createPromotionCode } from './promotions'
import { extendTrial, resolveTrial } from './trials'
import { preparePrepaidRefund, decidePrepaidRefund, reconcilePrepaidRefund } from './prepaid-refund-actions'
import { preparePrepaidTopupAuthorization, decidePrepaidTopupAuthorization, revokePrepaidTopupAuthorization } from './prepaid-topup-authorization'
import { reconcilePrepaidTopup } from './prepaid-topup-charge'
import { runPrepaidTopupFromDoor } from './prepaid-topup-actions'
import { prepareNativeReconfirmation, confirmNativeReconfirmation } from './payments/reconfirmation'
import { bindNativeCollectionCustomer, prepareNativeCollection, confirmNativeCollection, reconcileNativeCollection } from './payments/collection'
import { preparePrepaid, decidePrepaid, revokePrepaidConsent } from './prepaid-terms'
import { preparePrepaidPurchase } from './prepaid-purchase'
import { confirmPrepaidFunding } from './prepaid-funding'
import { settlePrepaid } from './prepaid-issue'
import { decideIntervalCancellation } from './interval-cancel'
import { createBillingEntity,updateBillingEntity,assignCustomerEntity } from './billing-entities'
import { captureNumberingSource,captureLiveCustomerNumberingSource } from './numbering-source'
import { prepareImportedCollection,executeImportedCollection,reconcileImportedCollection,finalizeImportedCollection } from './movein/collection'
import { refreshCorrectingInvoice } from './usage-correction-refresh'
import { configureUsagePolicy, prepareUsageCorrection, authorizeUsageCorrection, decideUsageCorrection } from './usage-dispositions'
import { configureInvoiceSeries } from './invoice-numbering'
import { configureFeaturePolicy } from './feature-policy'
import { configurePortal, issuePortalSession, revokePortalSession } from './portal-policy'
import { previewUsageCorrection } from './usage-replay'
import { requestErasure, verifyErasureOtherwise } from './erasure-requests'
import { approveErasure } from './erasure'
import { purgeErasure } from './erasure-purge'
import { prepareCadencePolicyFromDoor, disputeFromDoor } from './cadence-door'
import { decideCadencePolicy } from './cadence-policy'
import { enrollCadence, recordPromise, resolveDispute, approveCadenceStage } from './cadence-actions'
import { runCadencesManually } from './cadence-scheduler'
import { billingAnswer } from './billing-answers'
import { proposeAnswerCredit } from './answer-proposals'
import { prepareRetentionPolicy,decideRetentionPolicy } from './retention-policy'
import { prepareTerm,decideTerm,issueCancellationLink } from './renewal-terms'
import { prepareInvoiceCredit } from './credit-correction'
import { setReportSchedule } from './report-schedules'
import { confirmTotp, passkeyOptions, registerPasskey, removeFactor, resetFactors, setPolicy, startTotp, verifyFactor, verifyPasskey } from './mfa'
import { resolveSetup } from './setup-resolution'
// Every state change in Nectar, by name. The same handler serves the HTML form
// door (/app/do/NAME) and the JSON door (/api/nectar/NAME) used by agents.
// Each handler checks the actor's capability itself before touching data.
import type { Bindings } from '../auth.server'
import type { Actor } from './actor'
import { defineRole, endAccess, giveAccess, issueKey, pinKeyVersion, revokeKey, updateRole } from './access'
import { approve, finalise, prepareRun } from './billruns'
import { configureBusiness, declareTax, reviewTax } from './business'
import { createMeter, createPrice, createProduct, grantFeature, retirePrice } from './catalog'
import { approveReminder, completeTask, createTask, discardReminder, prepareReminder } from './collections'
import { addContact, createCustomer, updateCustomer } from './customers'
import { claimExemption, collectCertificate, validateCertificate } from './certificates'
import { configureCertificatePolicy, remindCertificates } from './certificate-reminders'
import type { Input } from './input'
import { adopt, applyImport, importAction, previewImport } from './movein/stripe'
import { decide, propose } from './proposals'
import { allocate, approveCredit, issueCreditNote, prepareCredit, recordPayment } from './receivables'
import { createSubscription, decideAmendment, decideChange, endSubscription, prepareChange, proposeAmendment } from './subscriptions'
import { acknowledgeControl, recordControl } from './reconciliation'
import { decidePrice } from './price-versions'
import { decidePolicyChange } from './policy-changes'
import { configureCreditPolicy } from './credit-policy'
import { addCharge } from './one-time-charges'
import { prepareManualInvoice } from './manual-invoices'
import { attachAddon } from './addons'
import { addNote } from './notes'
import { writeMetadata } from './metadata'
import { setNotificationPreferences } from './notifications'
import { cancelSubscription, reactivateSubscription } from './lifecycle-cancel'
import { configureLifecyclePolicy } from './lifecycle-policy'
import { pauseSubscription, resumeSubscription } from './lifecycle'
import { submitUsage } from './usage'

import { prepareContract,decideContract } from './contract-terms'

import { prepareMetric,previewMetric,activateMetric } from './meter-definitions'

type Handler = (env: Bindings, actor: Actor, input: Input, request: Request) => Promise<unknown>

export const actions: Record<string, Handler> = {
  'sso.configure': configureSso,
  'assurance.scan': scanAssurance,
  'assurance.assign': assignAssurance,
  'assurance.approve': approveAssurance,
  'assurance.recheck': recheckAssurance,
  'plan.change.credit.prepare': preparePlanChangeCredit,
  'plan.change.prepare': preparePlanChange,
  'plan.change.decide': decidePlanChange,
  'hierarchy.configure': setHierarchy,
  'hierarchy.invoice.prepare': prepareConsolidation,
  'hierarchy.commitment': recordHierarchyCommitment,
  'app.invoice.preview': appInvoicePreview,
  'shadow.app.prepare': prepareShadowAppChange,
  'shadow.app.confirm': confirmShadowAppChange,
  'shadow.app.reconcile': reconcileShadowAppChange,
  'shadow.app.preview': shadowInvoicePreview,
  'webhook.stripe.consume': consumeStripeWebhookEvent,
  'webhook.register': registerWebhook,
  'webhook.rotate': rotateWebhook,
  'webhook.disable': disableWebhook,
  'webhook.replay': replayWebhook,
  'webhook.dispatch': dispatchWebhookDoor,
  'collection.customer.bind': bindNativeCollectionCustomer,
  'payment_link.approve': approvePaymentLink,
  'payment_link.activate': activatePaymentLink,
  'payment_link.create': createPaymentLink,
  'payment_link.deactivate': deactivatePaymentLink,
  'dunning.policy.create': createDunningPolicy,
  'dunning.enroll': enrollDunning,
  'dunning.mail.prepare': prepareDunningMail,
  'dunning.mail.send': sendDunningMail,
  'dunning.end': endDunning,
  'dunning.withdraw': revokeDunning,
  'retry.method.prepare': prepareRetryMethodRecovery,
  'retry.method.decide': decideRetryMethodRecovery,
  'retry.churn.record': recordRetryChurn,
  'retry.policy.configure': configureRetryPolicy,
  'retry.segment.assign': assignRetrySegment,
  'automatic.collection.prepare': prepareAutomaticCollection,
  'automatic.collection.decide': decideAutomaticCollection,
  'automatic.collection.revoke': revokeAutomaticCollection,
  'automatic.collection.reconcile': checkAutomaticCollection,
  'automatic.collection.event': consumeAutomaticEvent,
  'collection.prepare': prepareNativeCollection,
  'collection.confirm': confirmNativeCollection,
  'collection.reconcile': reconcileNativeCollection,
  'collection.recovery.prepare': prepareNativeReconfirmation,
  'collection.recovery.confirm': confirmNativeReconfirmation,
  'payment.ach_evidence.record':recordAchPaymentEvidence,
  'customer.payment_methods.refresh':refreshCustomerPaymentMethods,
  'checkout.setup.prepare':prepareHostedSetup,
  'portal.method.prepare':preparePortalMethodAction,
  'card.lifecycle.consume':consumeCardLifecycleEvent,
  'card.expiry.prepare':prepareCardExpiryNotice,
  'card.expiry.send':sendCardExpiryNotice,
  'currency.rate.record':recordDailyRate,
  'trial.collection.prepare':prepareTrialCollection,
  'trial.collection.confirm':confirmTrialCollection,
  'trial.collection.approve':approveTrialCollection,
  'trial.collection.revoke':revokeTrialCollection,
  'prepaid.refund.notice.configure':configureRefundNotices,
  'prepaid.refund.request':requestSupportPrepaidRefund,
  'prepaid.refund.prepare':preparePrepaidRefund,
  'prepaid.refund.decide':decidePrepaidRefund,
  'prepaid.refund.reconcile':reconcilePrepaidRefund,
  'prepaid.topup.prepare':preparePrepaidTopupAuthorization,
  'prepaid.topup.decide':decidePrepaidTopupAuthorization,
  'prepaid.topup.revoke':revokePrepaidTopupAuthorization,
  'prepaid.topup.run':runPrepaidTopupFromDoor,
  'prepaid.topup.reconcile':reconcilePrepaidTopup,
  'prepaid.prepare': preparePrepaid,
  'prepaid.decide': decidePrepaid,
  'prepaid.purchase.prepare': preparePrepaidPurchase,
  'prepaid.funding.confirm': confirmPrepaidFunding,
  'prepaid.consent.revoke': revokePrepaidConsent,
  'prepaid.settle': settlePrepaid,
  'portal.change.policy': preparePortalChangePolicy,
  'portal.configure': configurePortal,
  'portal.session.issue': issuePortalSession,
  'portal.session.revoke': revokePortalSession,
  'erasure.request':requestErasure,
  'erasure.verify':verifyErasureOtherwise,
  'erasure.approve':approveErasure,
  'erasure.purge':purgeErasure,
  'cadence.policy.prepare':prepareCadencePolicyFromDoor,
  'cadence.policy.decide':decideCadencePolicy,
  'cadence.enroll':enrollCadence,
  'cadence.promise':recordPromise,
  'cadence.dispute':disputeFromDoor,
  'cadence.resolve':resolveDispute,
  'cadence.approve':approveCadenceStage,
  'cadence.run':runCadencesManually,
  'invoice.automation.prepare':prepareInvoiceAutomation,
  'invoice.automation.decide':decideInvoiceAutomation,
  'invoice.automation.run':runInvoiceAutomationDoor,
  'answer.read':billingAnswer,
  'answer.propose':proposeAnswerCredit,
  'retention.policy.prepare':prepareRetentionPolicy,
  'retention.policy.decide':decideRetentionPolicy,
  'term.prepare':prepareTerm,
  'term.decide':decideTerm,
  'term.link':issueCancellationLink,
  'proposal.credit.prepare':prepareInvoiceCredit,
  'imported.collection.prepare':prepareImportedCollection,
  'imported.collection.execute':executeImportedCollection,
  'imported.collection.reconcile':reconcileImportedCollection,
  'imported.collection.finalize':finalizeImportedCollection,
  'report.schedule':setReportSchedule,
  'setup.resolve':resolveSetup,
  'meter.prepare':prepareMetric,
  'meter.preview':previewMetric,
  'meter.activate':activateMetric,
  'contract.prepare':prepareContract,
  'contract.decide':decideContract,
  'business.configure': configureBusiness,
  'invoice.series': configureInvoiceSeries,
  'entity.create':createBillingEntity,
  'entity.update':updateBillingEntity,
  'customer.entity':assignCustomerEntity,
  'invoice.series.capture':captureNumberingSource,
  'invoice.series.capture-live':captureLiveCustomerNumberingSource,
  'tax.declare': declareTax,
  'tax.review': reviewTax,
  'mfa.policy': setPolicy,
  'mfa.reset': resetFactors,
  'mfa.remove': removeFactor,
  'mfa.totp.start': startTotp,
  'mfa.totp.confirm': confirmTotp,
  'mfa.verify': verifyFactor,
  'mfa.passkey.options': passkeyOptions,
  'mfa.passkey.register': registerPasskey,
  'mfa.passkey.verify': verifyPasskey,
  'access.give': giveAccess,
  'access.end': endAccess,
  'role.define': defineRole,
  'role.update': updateRole,
  'credential.issue': issueKey,
  'credential.revoke': revokeKey,
  'credential.version': pinKeyVersion,
  'exemption.claim': claimExemption,
  'certificate.collect': collectCertificate,
  'certificate.review': validateCertificate,
  'certificate.policy': configureCertificatePolicy,
  'certificate.remind': remindCertificates,
  'note.add': addNote,
  'metadata.write': writeMetadata,
  'notification.preferences': setNotificationPreferences,
  'customer.create': createCustomer,
  'customer.update': updateCustomer,
  'contact.add': addContact,
  'product.create': createProduct,
  'meter.create': createMeter,
  'price.create': createPrice,
  'price.decide': decidePrice,
  'price.retire': retirePrice,
  'feature.policy': configureFeaturePolicy,
  'feature.grant': grantFeature,
  'charge.add': addCharge,
  'invoice.manual': prepareManualInvoice,
  'subscription.addon': attachAddon,
  'subscription.create': createSubscription,
  'subscription.end': endSubscription,
  'lifecycle.policy': configureLifecyclePolicy,
  'subscription.cancel': cancelSubscription,
  'subscription.cancel.decide':decideIntervalCancellation,
  'subscription.reactivate': reactivateSubscription,
  'subscription.pause': pauseSubscription,
  'subscription.resume': resumeSubscription,
  'amendment.propose': proposeAmendment,
  'amendment.decide': decideAmendment,
  'change.prepare': prepareChange,
  'change.decide': decideChange,
  'usage.correction.policy': configureUsagePolicy,
  'usage.correction.prepare': prepareUsageCorrection,
  'usage.correction.authorize': authorizeUsageCorrection,
  'usage.correction.decide': decideUsageCorrection,
  'usage.correction.preview': previewUsageCorrection,
  'usage.submit': submitUsage,
  'usage.control': recordControl,
  'usage.acknowledge': acknowledgeControl,
  'billrun.prepare': prepareRun,
  'invoice.correction.refresh': refreshCorrectingInvoice,
  'processor.event.consume': consumeProcessorEvent,
  'processor.cash.allocate': allocateProcessorCash,
  'processor.cash.imported.prepare': prepareImportedCashTakeover,
  'processor.cash.imported.confirm': confirmImportedCashTakeover,
  'processor.cash.return.preview': previewProcessorCashReturn,
  'processor.cash.return.prepare': prepareProcessorCashReturn,
  'processor.cash.return.execute': executeProcessorCashReturn,
  'processor.cash.return.reconcile': reconcileProcessorCashReturn,
  'invoice.refund.preview': previewInvoiceRefund,
  'invoice.refund.prepare': prepareInvoiceRefund,
  'invoice.refund.execute': executeInvoiceRefund,
  'invoice.refund.reconcile': reconcileInvoiceRefund,
  'invoice.void.prepare': prepareInvoiceVoid,
  'invoice.void': voidInvoice,
  'invoice.approve': approve,
  'invoice.finalise': finalise,
  'policy.decide': decidePolicyChange,
  'credit.policy': configureCreditPolicy,
  'credit.prepare': prepareCredit,
  'credit.approve': approveCredit,
  'credit.issue': issueCreditNote,
  'writeoff.issue': issueWriteOff,
  'writeoff.prepare': prepareWriteOff,
  'writeoff.approve': approveWriteOff,
  'writeoff.recover': recoverWriteOff,
  'ledger.post': postPendingLedger,
  'revenue.close': closePeriod,
  'balance.goodwill': grantGoodwill,
  'balance.return': returnBalance,
  'balance.prepare': prepareBalanceRequest,
  'balance.approve': approveBalanceRequest,
  'balance.apply': applyBalance,
  'coupon.create': createCoupon,
  'promotion.create': createPromotionCode,
  'trial.extend': extendTrial,
  'trial.resolve': resolveTrial,
  'bank.remittance.preview': previewPlaidRemittances,
  'bank.remittance.confirm': confirmPlaidRemittances,
  'remittance.upload': uploadRemittances,
  'remittance.preview': previewRemittance,
  'remittance.confirm': confirmRemittance,
  'remittance.allocate.preview': previewRemittanceAllocation,
  'remittance.allocate': allocateRemittance,
  'payment.record': recordPayment,
  'payment.allocate': allocate,
  'reminder.prepare': prepareReminder,
  'reminder.approve': approveReminder,
  'reminder.discard': discardReminder,
  'task.create': createTask,
  'task.complete': completeTask,
  'proposal.create': propose,
  'proposal.decide': decide,
  'import.preview': previewImport,
  'import.apply': applyImport,
  'import.job': importAction,
  'subscription.adopt': adopt,
}
