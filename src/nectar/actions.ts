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
  'answer.read':billingAnswer,
  'answer.propose':proposeAnswerCredit,
  'retention.policy.prepare':prepareRetentionPolicy,
  'retention.policy.decide':decideRetentionPolicy,
  'term.prepare':prepareTerm,
  'term.decide':decideTerm,
  'term.link':issueCancellationLink,
  'proposal.credit.prepare':prepareInvoiceCredit,
  'report.schedule':setReportSchedule,
  'setup.resolve':resolveSetup,
  'meter.prepare':prepareMetric,
  'meter.preview':previewMetric,
  'meter.activate':activateMetric,
  'contract.prepare':prepareContract,
  'contract.decide':decideContract,
  'business.configure': configureBusiness,
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
  'subscription.reactivate': reactivateSubscription,
  'subscription.pause': pauseSubscription,
  'subscription.resume': resumeSubscription,
  'amendment.propose': proposeAmendment,
  'amendment.decide': decideAmendment,
  'change.prepare': prepareChange,
  'change.decide': decideChange,
  'usage.correction.preview': previewUsageCorrection,
  'usage.submit': submitUsage,
  'usage.control': recordControl,
  'usage.acknowledge': acknowledgeControl,
  'billrun.prepare': prepareRun,
  'invoice.approve': approve,
  'invoice.finalise': finalise,
  'policy.decide': decidePolicyChange,
  'credit.policy': configureCreditPolicy,
  'credit.prepare': prepareCredit,
  'credit.approve': approveCredit,
  'credit.issue': issueCreditNote,
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
