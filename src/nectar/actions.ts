// Every state change in Nectar, by name. The same handler serves the HTML form
// door (/app/do/NAME) and the JSON door (/api/nectar/NAME) used by agents.
// Each handler checks the actor's capability itself before touching data.
import type { Bindings } from '../auth.server'
import type { Actor } from './actor'
import { endAccess, giveAccess, issueKey, revokeKey } from './access'
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
import { submitUsage } from './usage'

type Handler = (env: Bindings, actor: Actor, input: Input, request: Request) => Promise<unknown>

export const actions: Record<string, Handler> = {
  'business.configure': configureBusiness,
  'tax.declare': declareTax,
  'tax.review': reviewTax,
  'access.give': giveAccess,
  'access.end': endAccess,
  'credential.issue': issueKey,
  'credential.revoke': revokeKey,
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
  'feature.grant': grantFeature,
  'charge.add': addCharge,
  'invoice.manual': prepareManualInvoice,
  'subscription.addon': attachAddon,
  'subscription.create': createSubscription,
  'subscription.end': endSubscription,
  'amendment.propose': proposeAmendment,
  'amendment.decide': decideAmendment,
  'change.prepare': prepareChange,
  'change.decide': decideChange,
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
