# Changelog

## 0.1.1 — 2026-11-26

The first published release since the v0.1.0 tag. Nectar is subscription billing for a B2B software or service business, and it runs in your own Cloudflare account; it never collects payments or sends anything for you.

Prepare Nectar for hosted installation with a generated deployment specification, dispatch-only Managed delivery, traceable Base packaging source and configured mail relay support. Billing and move-in obligations remain unchanged.

### What a billing team gets

- **Prices, meters and contract terms.** Versioned prices and metric meters, renewal and contract terms, amendments and approved exceptions.
- **Invoices you can explain.** Approved, numbered invoices with manual invoices, credit notes and corrections, partial payments and payment schedules.
- **Payment evidence and recovery.** Payment links, card lifecycle and expiry notices, retries and dunning sequences, voids, refunds, processor events and remittances, all recorded as evidence.
- **Collections with evidence.** Cadences, diagnoses and proposals bound to exact payment evidence; contact is held for unallocated disputed payments.
- **Customer financial privacy.** Ledgers, balances and entitlement evidence are read only with the matching financial capabilities, and withdrawn after erasure.
- **Tax quarters and exports.** Frozen quarter tax sources and scoped CSV exports.
- **Mail optional.** A Business can run Nectar with mail off, or configure a mail relay before enabling outbound delivery.

### Not in this release

Nectar does not collect payments, send mail on its own, or give tax or accounting advice.

### Upgrading

Install the updated source and retain existing migration names and bytes; every migration added since v0.1.0 is listed in RELEASE.json. Configure the selected mail provider before enabling outbound delivery.

## 0.1.0 — 2026-10-15

First tagged version of Nectar: customers, versioned prices and meters, subscriptions with approved contract exceptions, usage with stable ids, deterministic rating, approved and numbered invoices, credit notes, payment evidence, ageing and reminders, agent proposals that a person approves, and a Stripe Billing move-in kit.
