// DEV-001: the lifecycle events Nectar sends, and the published mapping from the
// Stripe Billing webhook events an app commonly consumes to the Nectar event that
// replaces each. GET /api/nectar/webhooks and API.md publish the same lists.
export interface EventKind { kind: string; family: string; about: string; emitted: boolean }

export const EVENT_KINDS: EventKind[] = [
  { kind: 'customer.created', family: 'customer', about: 'A customer was added by a person, the API or a move-in.', emitted: true },
  { kind: 'customer.updated', family: 'customer', about: 'A customer record changed, including archiving.', emitted: true },
  { kind: 'subscription.created', family: 'subscription', about: 'A subscription was started, including a shadow subscription moved in from the previous biller.', emitted: true },
  { kind: 'subscription.updated', family: 'subscription', about: 'A subscription changed: plan or quantity change, amendment, trial, term, renewal, pause, cancellation or adoption.', emitted: true },
  { kind: 'subscription.canceled', family: 'subscription', about: 'A subscription received an end date; data.object.end_date is when it ends.', emitted: true },
  { kind: 'subscription.paused', family: 'subscription', about: 'A pause was recorded; data.object.transition carries its dates and access.', emitted: true },
  { kind: 'subscription.resumed', family: 'subscription', about: 'A paused subscription was resumed.', emitted: true },
  { kind: 'subscription.reactivated', family: 'subscription', about: 'A canceled subscription was reactivated.', emitted: true },
  { kind: 'invoice.created', family: 'invoice', about: 'An invoice was drafted (bill run, manual invoice or correction).', emitted: true },
  { kind: 'invoice.finalized', family: 'invoice', about: 'An invoice was issued with its number.', emitted: true },
  { kind: 'invoice.paid', family: 'invoice', about: 'A payment allocation or a credit-balance application brought an issued invoice to a zero balance.', emitted: true },
  { kind: 'payment.recorded', family: 'payment', about: 'A payment was recorded, by a person or by an owner-confirmed processor charge.', emitted: true },
  { kind: 'payment.failed', family: 'payment', about: 'An owner-confirmed processor charge was declined or needs customer action.', emitted: true },
  { kind: 'credit_note.created', family: 'credit', about: 'A credit note was issued against an invoice.', emitted: true },
  { kind: 'customer_balance.updated', family: 'credit', about: 'A goodwill grant, balance application or recorded balance return changed a customer credit balance.', emitted: true },
  { kind: 'entitlements.updated', family: 'entitlement', about: "A customer's active features changed; data.object lists the features granted today and before.", emitted: true },
  { kind: 'usage.threshold_crossed', family: 'usage threshold', about: 'A usage or spend threshold was crossed. Sent once thresholds ship (USE-005).', emitted: false },
]

export interface StripeMapping { stripe: string; nectar: string | null; note: string }

/** The Stripe Billing events an app commonly consumes, and what Nectar sends instead. */
export const STRIPE_MAP: StripeMapping[] = [
  { stripe: 'customer.created', nectar: 'customer.created', note: '' },
  { stripe: 'customer.updated', nectar: 'customer.updated', note: '' },
  { stripe: 'customer.deleted', nectar: 'customer.updated', note: 'Nectar archives customers and never deletes them: read data.object.status.' },
  { stripe: 'customer.subscription.created', nectar: 'subscription.created', note: '' },
  { stripe: 'customer.subscription.updated', nectar: 'subscription.updated', note: '' },
  { stripe: 'customer.subscription.deleted', nectar: 'subscription.canceled', note: 'Sent when the end date is recorded; data.object.end_date is the day service ends.' },
  { stripe: 'customer.subscription.paused', nectar: 'subscription.paused', note: '' },
  { stripe: 'customer.subscription.resumed', nectar: 'subscription.resumed', note: '' },
  { stripe: 'customer.subscription.trial_will_end', nectar: null, note: 'No advance trial notice: read trial_end on subscription events; the trial outcome arrives as subscription.updated.' },
  { stripe: 'invoice.created', nectar: 'invoice.created', note: 'Bill-run drafts can be prepared again; act on invoice.finalized.' },
  { stripe: 'invoice.finalized', nectar: 'invoice.finalized', note: '' },
  { stripe: 'invoice.paid', nectar: 'invoice.paid', note: '' },
  { stripe: 'invoice.payment_succeeded', nectar: 'invoice.paid', note: 'Stripe sends both; Nectar sends invoice.paid once.' },
  { stripe: 'invoice.payment_failed', nectar: 'payment.failed', note: 'Owner-confirmed charges only until automatic collection ships (PAY-003).' },
  { stripe: 'invoice.payment_action_required', nectar: 'payment.failed', note: 'data.object.status is customer_action_required.' },
  { stripe: 'invoice.voided', nectar: null, note: 'Issued invoices are corrected by credit note (credit_note.created); voids ship with INV-005.' },
  { stripe: 'invoice.upcoming', nectar: null, note: 'Read GET /api/nectar/subscriptions/{id}/upcoming.' },
  { stripe: 'payment_method.attached', nectar: null, note: 'Nectar keeps no payment methods until PAY-002 and PORT-004 ship them.' },
  { stripe: 'payment_method.updated', nectar: null, note: 'Nectar keeps no payment methods until PAY-002 and PORT-004 ship them.' },
  { stripe: 'payment_method.detached', nectar: null, note: 'Nectar keeps no payment methods until PAY-002 and PORT-004 ship them.' },
  { stripe: 'entitlements.active_entitlement_summary.updated', nectar: 'entitlements.updated', note: '' },
]

export const isEventKind = (kind: string) => EVENT_KINDS.some(event => event.kind === kind && event.emitted)
