Version: `nectar-declines-2026-10-27`.

Nectar schedules PaymentIntent confirmations itself. It never invokes Stripe
Billing retries. Retry consent is off by default. An owner with a fresh factor
includes the frozen limits in one exact invoice's terms; the authenticated
customer accepts them and an authorized human approves them through the ordinary
automatic-collection door. Changing a default method or policy never widens that
consent. A customer or owner can withdraw future retries after a definitive failure.

| Verified reason | Delay after each definitive failure | Limit |
| --- | --- | --- |
| `processing_error` | 4 elapsed hours | 8 total attempts within 14 elapsed days |
| `do_not_honor` | 24 elapsed hours | 8 total attempts within 14 elapsed days |
| Card `insufficient_funds` | 72 elapsed hours | 8 total attempts within 14 elapsed days |
| Bank R01 or R09 | 72 elapsed hours | 3 total attempts, including the original; default 40 elapsed days |
| Any other reason | No retry | Wait for a separately authorized resolution |

All counts include the first failed payment. The owner may set a lower count and
shorter window globally, for a catalogue price used by a plan, or for an explicitly assigned retry segment. When an invoice
contains several overridden prices or a segment override, the smallest count and shortest window apply independently. Segment assignment and clearing are explicit owner actions in Settings; cadence labels and customer metadata never enroll anyone. Without an applicable override, the global default applies.
The exact selected limits and table version are frozen before customer acceptance.
The current settings door permits 1–8 total attempts and 1–14 days; the unmodified
bank default is 3 total attempts in 40 days. Neither an overdue tick nor a restart
runs attempts after the frozen deadline. A repeated tick cannot repeat a claimed
confirmation. Unknown results reconcile through provider reads of the same
PaymentIntent; they never authorize another write.

Hard card declines never retry the same method: `incorrect_number`, `lost_card`,
`pickup_card`, `stolen_card`, `revocation_of_authorization`,
`revocation_of_all_authorizations`, `authentication_required`, `highest_risk_level`
and `transaction_not_allowed`. A charge carrying `do_not_try_again` advice also
stops. Bank R02, R03, R05, R07, R10 and R29 never retry. Stripe's normalized
`insufficient_funds` bank failure is classified as `ach_insufficient_funds`, with the same limits as R01 and R09;
Nectar never invents a raw return code when the provider supplied only a normalized
reason. `bank_account_closed`, `bank_account_invalid_details` and
`debit_not_authorized` are prohibited. Unknown bank codes stop. At most two reinitiations are possible,
within the stricter consent window and 180-day outer cap. This is a conservative
implementation limit, not a legal compliance certification.

Any open invoice dispute pauses all retries, preserving the broader DUN-001 stop.
An authorized resolution permits the still-valid schedule to resume. Paid invoices,
changed or missing methods, erased customers, revoked authority, changed financial
bases and unusable methods permit no retry. No retry email or receipt is sent.
Existing consented developer webhook endpoints receive an immutable
`invoice.payment_failed` event with the same next time and count shown by the
invoice page and API at the time the failure is recorded. `next_payment_attempt`
is an epoch timestamp in milliseconds, or null when no attempt is currently allowed.

Current limits remain explicit: this slice supports native test-mode Stripe
collection only. A hard-declined card can be replaced through a fresh owner preparation,
new exact customer consent and human approval of one confirmation on the same
PaymentIntent. The original approved terms remain immutable. Same-method
authentication recovery requires separate owner preparation, exact customer acceptance and human approval. The accepting customer then confirms once through the bank on the same PaymentIntent. Approval alone never schedules authentication; the card stays blocked for unattended use and no other invoice is authorized. Return parameters are discarded before a clean authenticated page, and uncertain outcomes reconcile through reads only. Other processors, production operation and the full
live decline and bank matrix remain unproved. CT approval of automatic retries is
pending. Historical retry facts confer no restored collection authority.

The timing is described as decline-table timing. The [comparison](/docs/retry-comparison)
publishes its known outcomes and both schedules. No production improvement is claimed.

Provider sources: [Stripe retry handling](https://docs.stripe.com/billing/revenue-recovery/smart-retries),
[card retry advice](https://docs.stripe.com/declines/card),
[network return codes](https://docs.stripe.com/declines/network-codes).

Stripe’s documented `authentication_not_handled` refusal enters the same blocked authentication state as `authentication_required`. Its original provider code remains in the refusal proof. See [Stripe decline codes](https://docs.stripe.com/declines/codes).
