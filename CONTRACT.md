# Nectar product contract

Nectar is subscription billing owned by the business that uses it. Its first
buyer is one US B2B software or service business billing monthly plans, seats
and simple metered usage, run by an owner and a finance operator, with an
outside accountant. Nectar turns agreed subscriptions and recorded usage into
invoices that can be explained line by line, then tracks credits, payment
evidence and overdue follow-up. It is an invoicing engine, not a merchant of
record and not a payment collector.

This document sets the required behaviour of the first release. Each numbered
clause says what a person can do; [ACCEPTANCE.md](ACCEPTANCE.md) names the test
that proves it and its current status. A named test is a target, not evidence,
until its result is recorded there.

## Operating rules

- **A fresh installation starts empty.** The owner enters the business, its catalog and its customers, or moves them in. Nothing is pre-filled with sample data.
- **Exact money.** Unit prices and quantities are exact decimals with at most six fractional places; nothing passes through binary floating point. Each invoice line rounds once to whole cents, half away from zero; tax is the declared rate on the taxable total, rounded once. The rule set is versioned (`nectar-rating-1`) and recorded on every invoice.
- **Same inputs, same bill.** Rating is a pure function of recorded inputs: the business's timezone and tax declaration, the customer's exemption, the subscription's dates, items, prices and approved contract exceptions, and the unbilled usage events. Those inputs are fingerprinted on every draft.
- **Approval names exact inputs.** Approving a draft records its input fingerprint. Finalising recomputes it; if usage, a price, a contract exception or the tax declaration changed, the approval no longer holds and the invoice is not issued.
- **History is append-only.** Price versions, issued invoices and their lines, credit notes, payments, allocations, the usage ledger and the audit trail are never edited or deleted. Corrections are new records: a credit note, a voided-and-replaced usage event, a new price version, a scheduled change.
- **Each period bills once.** A subscription period has at most one issued invoice, and a usage event is billed on at most one invoice; both are enforced inside the issuing transaction.
- **Roles are checked in every handler.** The owner does everything; a finance operator keeps records, imports usage, prepares and approves bill runs and works receivables; an accountant reads and exports. Every server handler checks the actor's capability itself, for pages, form posts, the JSON API and downloads alike; routes are not the boundary.
- **Agents prepare; people decide.** An application credential (scope `prepare` or `usage`) can read and propose, or submit usage. It can never approve, finalise, issue a credit, change a record directly or manage access. Every approval records the person who made it.
- **Nothing is sent or charged.** Nectar never collects a payment, holds card data, sends an invoice or a reminder, or marks anything as sent. Approved reminders are exported for the operator to send themselves.

## First release: sixteen clauses

Thirteen billing flows, then the agent, access and move-in requirements.

1. **Set up the business.** The owner records the legal name, billing address and email, a billing timezone, an invoice number prefix and payment terms, in US dollars only. The owner declares a tax policy for one US state (no sales tax, or one flat rate on taxable lines) with its basis, and reviews it. Invoices cannot be finalised until a declared policy has been reviewed; any later change needs a new review. The timezone cannot change once an invoice is issued.
2. **Keep customers and billing contacts.** Operators add customers under the business's own external id (the id a CRM or previous biller uses; usage files refer to customers by it), with a billing email, address and an optional tax exemption backed by a certificate reference, and add billing contacts. External ids and contact emails are unique; edits are guarded against concurrent changes.
3. **Version the catalog.** Operators define products, simple meters and prices: flat monthly, per seat monthly, or per unit of a meter. A price is an immutable version; a new price is the next version and earlier versions keep billing the subscriptions that use them. A retired version is unavailable to new subscriptions. Products grant named features.
4. **Start subscriptions.** Operators start a subscription with an explicit billing day (1–28), a start date, an optional trial end and one to twenty plan items with seat quantities. Contract exceptions — a discount on fixed and seat charges, a one-time credit, or a contract price for one plan price, each with dates, a note and the quoted clause — are recorded as proposed and bill only after a person approves them. One customer cannot have two live subscriptions rating the same meter.
5. **Bring in usage.** Operators upload a CSV, or an application credential posts events, each with a stable event id, customer id, meter, exact quantity and an ISO 8601 time with an explicit offset. An id already recorded with the same values is a duplicate and changes nothing; reused with different values, or with an unknown customer or meter or an unreadable time, it is rejected and reported by row. Each import is one atomic batch with its own report.
6. **Inspect before rating.** For any month, a person sees each metered subscription's exact period totals per meter, the period's boundaries in the billing timezone, days with no usage, events that arrived after the period ended, unbilled events from earlier periods and events no price rates.
7. **Rate deterministically.** Fixed and seat charges bill for the days of the period they are in effect, outside any trial; usage sums exact event quantities per price and multiplies once; late usage bills in the next period at the price in effect when it occurred; contract discounts and credits apply as approved. Preparing again from the same inputs yields the same lines and fingerprint.
8. **Schedule plan and quantity changes.** Operators prepare a change to one plan item from a date and see the affected period's charges before and after (with proration) and the next full period. A person approves that exact preview; it is refused if the subscription changed since, or if the date falls in a period already invoiced. The bill run charges exactly what the approved preview showed.
9. **Draft a bill run and compare it.** For a month, Nectar drafts one invoice per subscription period that started in it and has ended, lists periods not yet ended and periods already invoiced, compares each draft with the subscription's previous invoice and the run with the previous run, and lists exceptions (missing usage, large change, unrated usage, missing billing email, undeclared tax, credits beyond charges, disagreement with the previous biller). Preparing again replaces the draft.
10. **Approve and finalise numbered invoices.** A person approves one draft or every clean draft, acknowledging any listed exceptions; blocking exceptions cannot be approved. Finalising issues approved invoices whose inputs are unchanged with the next sequential number, an invoice date from the end of the period up to today and a due date from the payment terms, marks the billed usage, and keeps the accepted calculation, its fingerprint and rule version with the invoice. Issued invoices never change.
11. **Credit and record payments.** A person issues a numbered credit note against an issued invoice for no more than it still owes, with a reason. Operators record payments received outside Nectar with their method, unique reference and evidence, and allocate them to the customer's invoices, never beyond the payment's unallocated amount or the invoice's balance. For every invoice, total = credited + paid + owed.
12. **Follow up overdue balances.** Operators see ageing (not yet due, 1–30, 31–60, 61–90, over 90 days) per customer and invoice, draft a reminder stating the overdue invoices, balances and recent payments, and a person approves the exact recipient and wording while those balances still hold. The approved reminder downloads as a message to send from the operator's own mail, and approval opens a dated follow-up task that is closed with its outcome.
13. **Leave with the data and explain entitlements.** Accountants and operators download issued invoices, usage events and subscriptions as CSV, and any bill run as one JSON document with every invoice's lines, calculation inputs, fingerprint, approval and issue events. The whole installation exports with `rer export` and restores with `rer import` into a fresh installation with every portable row, including the calculation evidence, unchanged. For any customer, feature and date, Nectar explains whether the feature is granted, subscription by subscription, step by step.
14. **Let an agent prepare the work.** The owner issues scoped credentials. With `prepare`, an agent reads records and proposes (a) contract terms from a signed agreement, quoting each clause and flagging ambiguity; (b) a new price version for selected subscriptions from an exact date; (c) bill-run usage corrections with their sources; and (d) a collections reminder. Nectar computes the invoice effect of each proposal itself. A person approves or rejects; a proposal whose records changed since it was prepared is refused. Approving a usage correction re-prepares the draft run and approves no invoice. With `usage`, a pipeline submits usage events. Credentials are revocable.
15. **Control access.** The owner invites finance operators and accountants through Base operator sign-in, ends access (ending every session), and is the only one who changes business settings, the tax policy, access, credentials or a move-in cutover. Every page, form, API call and download enforces the role, signed-out requests get nothing, and cross-site form posts are refused.
16. **Move in from Stripe Billing.** Operators upload owner-captured Stripe API list responses for customers, products, prices, subscriptions, invoices and billing meters with a manifest of counts. Nectar refuses an incomplete capture, previews every record it would create or reject without writing anything, applies the exact reviewed preview as one journaled batch with its original files retained, adds nothing on a repeated apply, and undoes an untouched batch. Moved-in subscriptions arrive in shadow: they are rated and compared with Stripe's own invoices price by price but can never be approved or issued, until the owner adopts each one from a period Stripe has not billed. Once its records have been billed on, a move cannot be undone silently.

## Decided defaults

These defaults are decided:

- **Name:** Nectar (owner-adopted 10 October 2026; `run-nectar.com` registered 14 October).
- **Scope:** one business, B2B subscriptions, seats and simple per-unit metering; an owned rating engine; payment adapters later.
- **Jurisdiction and currency:** US and USD, with the state and tax policy declared and reviewed before any invoice is final; no global compliance claim.
- **Move-in order:** Stripe Billing records first, then Chargebee, Recurly and Maxio; an existing merchant of record stays in place.
- **Start order:** the provider-free rating and invoice loop first; then shadow migration; then payments and sending; then embedded agents and advanced wallets.
- **Billing timing:** each invoice covers one subscription period after it ends (arrears), dated from the period end up to the day it is issued; billing days are 1–28.

## Out of the first release

Payment collection, card custody and payment retries; sending invoices or reminders; merchant-of-record service; global or multi-state tax determination and filing; multiple entities or currencies; revenue recognition; graduated or volume tiers, minimum commitments and prepaid wallets; yearly or other non-monthly intervals; an embedded model account; agent-supplied SQL; Chargebee, Recurly and Maxio move-in kits; Stripe subscription schedules (recorded, not executed); high-volume metering claims; hosted operation, provider integrations and legal name clearance, which remain separate evidence.
