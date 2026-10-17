# Nectar acceptance record

Target edition: 17 October 2026. This record lists the acceptance evidence for
every clause in [CONTRACT.md](CONTRACT.md), with the same status as its Status
table, judged at commit `a38323a4ad258045cbe8a23a79d616d796433767`. Clause IDs
are stable; a build round works down this list and records each result here.

Status: **118 clauses: 18 done, 35 partial, 65 missing.**
All sixteen first-release clauses are **LOCAL PROVEN** (16 of 16); of the
94 target clauses 2 are proven, 29 partial and 63 missing; of the
8 push-further agent clauses 6 are partial and 2 missing.

Each first-release clause has one flow check in `tests/nectar/flows.mjs`
(`pnpm run test:flows`, part of `rer verify`), which builds the Worker and
drives it with real local D1 only through its public doors: the JSON API
(member sessions and bearer credentials), the HTML form door, pages and
downloads. The owner journey in `tests/nectar/journey.mjs`
(`pnpm run test:journey`, run from a disposable fresh clone) repeats a whole
billing cycle by hand in a real browser at 1440 pixels, renders every main
screen at 390 pixels, and proves the restore through `rer export` and
`rer import`. Target clauses are proven the same way, with fakes only at the
paid or network edge: Stripe test mode and test clocks, Adyen and Braintree
sandboxes, the Avalara sandbox, QuickBooks Online and Xero developer
companies, a NetSuite sandbox, a Salesforce developer org, a Plaid sandbox and
a Postmark sandbox server. **LOCAL PROVEN** covers local operation only; it
does not claim hosted operation, live provider behaviour, tax correctness or a
real buyer's invoice comparison. **PARTIAL** means part of the clause ships
with a cited test and the rest is listed in CONTRACT.md's Status table;
**MISSING** means the journey has no implementation yet.

## First release

| # | What a person can do | Test target | Status |
| --- | --- | --- | --- |
| NEC-01 | Set up the business identity, USD, billing timezone and a declared tax policy that must be reviewed before finalising | `NEC-01 business, currency, timezone and declared tax`; finalising refused until review in `NEC-10` | **LOCAL PROVEN** |
| NEC-02 | Keep customers and billing contacts under unique external ids, with exemptions backed by a reference | `NEC-02 customers and billing contacts with external ids` | **LOCAL PROVEN** |
| NEC-03 | Version products, flat, seat and per-unit prices and meters; earlier versions never change | `NEC-03 products, immutable price versions and meters` | **LOCAL PROVEN** |
| NEC-04 | Start subscriptions with a billing day, trial and contract exceptions that bill only once approved | `NEC-04 subscriptions with anchor, trial and approved exceptions` | **LOCAL PROVEN** |
| NEC-05 | Import or submit usage with stable ids; duplicates change nothing, conflicts and bad rows are reported | `NEC-05 usage with stable ids and duplicate rejection`; credential submission in `NEC-14` | **LOCAL PROVEN** |
| NEC-06 | Inspect exact period totals, timezone boundaries, gaps, late and unrated events before rating | `NEC-06 missing and late usage and exact totals before rating` | **LOCAL PROVEN** |
| NEC-07 | Rate fixed, seat and unit charges with exact decimals, proration and explicit rounding, reproducibly | `NEC-07 deterministic rating with explicit rounding` | **LOCAL PROVEN** |
| NEC-08 | Schedule plan and quantity changes from a previewed proration; the bill equals the approved preview | `NEC-08 scheduled changes bill exactly as previewed` | **LOCAL PROVEN** |
| NEC-09 | Draft a bill run, compare with previous invoices and runs, list exceptions; late usage bills next period | `NEC-09 draft bill run comparison and exceptions` | **LOCAL PROVEN** |
| NEC-10 | Approve and finalise numbered invoices bound to their inputs; source changes invalidate approval; nothing bills twice | `NEC-10 approval, source changes and numbered finalisation` | **LOCAL PROVEN** |
| NEC-11 | Issue credit notes and allocate externally evidenced payments without breaking total = credited + paid + owed | `NEC-11 credit notes, payment evidence and allocations` | **LOCAL PROVEN** |
| NEC-12 | See ageing, approve a reminder's exact recipient and wording while balances hold, export it, close the follow-up | `NEC-12 ageing, reminder drafts and follow-up tasks` | **LOCAL PROVEN** |
| NEC-13 | Export invoices, usage, subscriptions and bill runs with calculation evidence; restore the installation; explain entitlements | `NEC-13 exports and entitlement explanations`; restore round trip in `tests/nectar/journey.mjs` | **LOCAL PROVEN** |
| NEC-14 | Let an agent prepare contract terms, price changes, usage corrections and reminders that only a person approves | `NEC-14 agent prepares, a person approves` | **LOCAL PROVEN** |
| NEC-15 | Owner controls access; every handler enforces roles; signed-out and cross-site requests get nothing | `NEC-15 roles are enforced in every handler` (crawls every action and every GET door) | **LOCAL PROVEN** |
| NEC-16 | Move in from Stripe Billing: dry run, journal, undo, shadow comparison, cutover without replaying billed periods | `NEC-16 Stripe Billing move-in with dry run, journal, undo and shadow cutover` | **LOCAL PROVEN** |

## Target: Business setup and catalogue

| # | What a person can do | Test target | Status |
| --- | --- | --- | --- |
| SET-001 | Multiple billing entities | Create two entities with separate Stripe test accounts and QuickBooks companies, bill one customer from each, and see independent invoice sequences, charges on the right processor account, entity-filtered and consolidated revenue reports, and journals posted to the right company. | **MISSING** |
| CAT-001 | Billing intervals and terms | Start a 24-month subscription with an annual $12,000 platform fee billed in advance and monthly metered usage in arrears; advance a test clock through 25 months and see one platform invoice per year on the anniversary, 24 monthly usage invoices, a co-termed add-on prorated to the term end, and identical totals on re-preparation. | **MISSING** |
| CAT-002 | Tiered, volume, package and graduated pricing | Rate 0, 1, 1,000, 1,001 and 2,500,000 units under each model through the bill run and compare every line and its tier breakdown with hand-computed expected cents, including the exact tier boundaries. | **MISSING** |
| CAT-003 | Minimum commitments, overages and ramps | Sign a three-year ramp with a $50,000 annual minimum; under-use in year one and over-use in year two; see the true-up line at the year-one end, overage lines in year two, the ramp price switch on its date, and a burn-down that matches the issued invoices. | **MISSING** |
| CAT-004 | Prepaid credits and drawdown | Sell a $10,000 credit block, consume it across two periods with a promotional grant that expires first, trigger an automatic $5,000 top-up at a $1,000 balance, and see the ledger, the invoice lines drawing credits, the top-up charge and the expiry all agree. | **MISSING** |
| CAT-005 | Discounts, coupons, promotion codes and trials | Redeem a 20%-for-three-months promotion code at checkout, exhaust its redemption limit, refuse an expired code, and run a no-card trial that ends unpaid and a card trial that converts and charges on the trial end date. | **PARTIAL** |
| CAT-006 | One-time charges, add-ons and manual invoices | Add a $2,500 implementation fee to a new subscription's first invoice, attach a seat-pack add-on mid-period, and issue a standalone services invoice; each appears once, with its tax and numbering. | **MISSING** |
| CAT-007 | Price changes across a customer base | Raise a plan from $499 to $549 for monthly customers at their next renewal while grandfathering annual contracts; the preview lists every affected subscription and its next invoice, approval schedules exactly those changes, and the bill runs charge the previewed amounts. | **PARTIAL** |
| CAT-008 | Multi-currency prices | Bill a Canadian customer in CAD and collect through a Stripe test account; the invoice, payment, credit and report show CAD amounts and a USD reporting value with the rate source and date. | **MISSING** |
| CAT-009 | Customer hierarchies and consolidated billing | Create a parent with three divisions, bill them on one consolidated invoice with per-division subtotals, then switch one division to its own invoice paid by the parent's card, and see a shared commitment drawn down by all three. | **MISSING** |

## Target: Customer record and search

| # | What a person can do | Test target | Status |
| --- | --- | --- | --- |
| CUS-001 | Find any customer and see the whole billing record | After a full billing cycle with card and ACH payments, a refund, a credit note and a moved-in Stripe history, search by billing email, partial name, invoice number, Stripe charge reference and card last four; each search returns the customer, and a search for one customer's email returns no other customer. The record lists every subscription, invoice, payment, refund, credit note, payment method, credit balance and audit event for that customer; its invoiced, paid, credited and owed totals equal the sum of its invoices; a signed-in support member sees it and issues a credit within their limit; a signed-out request and an accountant's attempt to act get nothing. | **PARTIAL** |
| CUS-002 | Notes and mentions on customers, invoices and payments | A support member adds a note to a payment mentioning the finance lead; the finance lead receives one email naming the payment, the note appears on the customer record and in the customer export, and an edit attempt is refused while a follow-up note is added. | **MISSING** |

## Target: Usage and metering

| # | What a person can do | Test target | Status |
| --- | --- | --- | --- |
| USE-001 | Metering API at production scale | Drive 100 million synthetic events through the API with duplicates and out-of-order times, measure sustained throughput and acknowledgement latency, and show period totals equal to an independent count with no event billed twice. | **PARTIAL** |
| USE-002 | Billable metrics and dimensions | Define sum, count, max, unique-users and GB-month meters over one event stream with a `model` property, price two models differently, and compare each period total with an independent computation over the raw events; define a SQL meter, preview it on three past months, and see a write statement refused. | **PARTIAL** |
| USE-003 | Bulk usage from storage and warehouses | Drop a 10-million-row Parquet file in an S3 test bucket and schedule a BigQuery query; re-delivering the same file changes nothing, a malformed row is reported, and totals match the source counts. | **MISSING** |
| USE-004 | Usage corrections after billing | Void 10,000 events from an issued July invoice under each policy and see the August late line, a correcting invoice, or a credit note, each citing the original events, with July's issued invoice unchanged. | **PARTIAL** |
| USE-005 | Usage alerts and threshold invoicing | Set a $5,000 threshold invoice and an 80% commitment alert, stream usage past both, and see one webhook and email per crossing, a mid-period invoice charged once, and the remaining period billing only the rest. | **MISSING** |
| USE-006 | Live usage and the upcoming invoice | Stream usage during a period and read the upcoming invoice through the API and portal; it matches the final issued invoice for the same inputs to the cent. | **PARTIAL** |
| USE-007 | Reconcile usage with its source | Send control totals that disagree with ingested events for two days; the bill run lists both as blocking exceptions naming the day, meter and difference, and resolving them by replay clears the block. | **PARTIAL** |

## Target: Subscription lifecycle

| # | What a person can do | Test target | Status |
| --- | --- | --- | --- |
| SUB-001 | Lifecycle states driven by dates and payments | With a Stripe test clock, run a card trial to active, fail its renewal payment to past due, exhaust dunning to unpaid, pay to recover to active, and cancel to ended; read the state history and the webhook for each step. | **PARTIAL** |
| SUB-002 | Immediate and scheduled plan changes with proration policy | Upgrade an annual in-advance plan mid-term with "invoice now", downgrade another at period end, and change a third without proration; each invoice or credit matches its preview and the payment collects through `PAY-003`. | **PARTIAL** |
| SUB-003 | Pause, resume and cancel | Pause for two months and resume, cancel immediately with a prorated credit, cancel another at term end, and reactivate a third; invoices, credits, entitlements and state history agree for each. | **PARTIAL** |
| SUB-004 | Renewals and renewal notices | Advance a test clock to 30 days before an annual renewal; the notice goes out with the new price and a cancellation link; one customer renews with a 5% uplift, one cancels online and does not renew. | **MISSING** |
| SUB-005 | Cancellation saves and win-backs | Cancel through the portal, accept a two-month 50% save offer and see it applied to the next two invoices; decline it on another account and see the cancellation complete with its reason. | **MISSING** |

## Target: Entitlements and developer platform

| # | What a person can do | Test target | Status |
| --- | --- | --- | --- |
| ENT-001 | Real-time entitlements API | Upgrade, downgrade, pause and fail payment on a subscription and poll the entitlements API from a test product; each change is visible within 5 seconds, measured p95 latency is under 50 ms, and each answer's explanation names the subscription and price. | **PARTIAL** |
| ENT-002 | Quotas and enforcement policy | Exhaust a 10,000-call quota under each policy; the entitlement API warns, denies or allows and bills accordingly; an unpaid subscription loses a gated feature after its three-day grace period and regains it on payment. | **MISSING** |
| DEV-001 | Signed outbound webhooks | Register an endpoint, take it down for an hour during a bill run, and see retries deliver every event once it returns; verify signatures, replay one event, rotate the secret with an overlap window and refuse a forged delivery in the receiving test app. | **MISSING** |
| DEV-002 | Documented public API | Generate a client from the published OpenAPI document and run the full billing cycle with it; repeat each write with the same idempotency key and get the original result with no second record. | **PARTIAL** |
| DEV-003 | SDKs and embeddable components | A sample app in each of the seven languages uses its SDK to meter usage, gate a feature and open checkout and the portal; the components render the live catalogue and complete a test-mode purchase. | **MISSING** |
| DEV-005 | Metadata on every object | Set `app_account_id` on a customer and a subscription through the API, find the customer by that value in search, receive it in the `invoice.paid` webhook payload, and read it back after `rer export` and `rer import`. | **MISSING** |
| DEV-004 | Test mode and test clocks | Copy the live catalogue into test mode, advance a test clock 13 months on an annual plan with a failing card, and see every invoice, retry, notice and state change happen; live data is untouched. | **MISSING** |

## Target: Invoicing and delivery

| # | What a person can do | Test target | Status |
| --- | --- | --- | --- |
| INV-001 | Automatic invoice runs | Enable auto-issue for clean drafts, advance a test clock across a billing day with one clean and one exception draft, and see the clean invoice issued, delivered and charged without a person while the exception waits for review. | **PARTIAL** |
| INV-002 | Invoice and receipt email delivery | Issue an invoice through the Postmark sandbox; the message carries the PDF and the hosted-page link and goes to the billing contacts with a customer's CC rule and the business's BCC archive address applied; an operator resends the issued invoice to a corrected address and both sends are recorded; delivery and a forced bounce are recorded on the invoice and the bounce opens a task to fix the contact. | **MISSING** |
| INV-003 | Hosted invoice page and PDF | Open an invoice's hosted link signed out, pay it with a Stripe test ACH account, and see the page and PDF move to paid with the receipt; an altered link returns nothing. | **MISSING** |
| INV-004 | Branded, B2B-ready invoices | Set a logo and Net 45 for one customer with a required PO number; the invoice, PDF and email show them, and finalising without the PO is blocked as an exception. | **PARTIAL** |
| INV-005 | Credit notes, voids and refunds | Void an unpaid invoice and reissue it, refund half of a card-paid invoice through Stripe test mode and credit the other half to balance; the processor refund, tax reversal, invoice state and customer ledger agree. | **PARTIAL** |
| INV-006 | Customer credit balance | Overpay an invoice by $200 with a wire, issue a $100 goodwill credit, and see both applied to the next invoice, with the remaining balance refundable and the ledger balanced. | **PARTIAL** |
| INV-007 | Partial and scheduled payments on the invoice page | Pay $400 of a $1,000 invoice by test card on its hosted page and schedule the remaining $600 by ACH for the due date; the invoice shows $600 owed until the scheduled payment settles on the test clock, then paid, with two payments recorded and one reminder suppressed. | **MISSING** |

## Target: Payments and collection

| # | What a person can do | Test target | Status |
| --- | --- | --- | --- |
| PAY-001 | Processor connections | Connect a Stripe test account, an Adyen sandbox and a Braintree sandbox, take a card and an ACH payment through each where supported, pay a Stripe Checkout session with a test Apple Pay or Google Pay wallet, route a CAD customer to a second Stripe account by currency, and see processor references recorded; disconnecting one blocks new charges on it without losing history. | **MISSING** |
| PAY-002 | Hosted checkout and payment-method capture | Complete a test checkout for a monthly plan with a card and another with ACH; the subscription, mandate and default payment method appear, and a search of Nectar's database, logs and exports finds no card or account number. | **MISSING** |
| PAY-003 | Automatic collection | Issue a card auto-charge invoice and an ACH one; the card pays immediately, the ACH shows pending and settles four business days later on the test clock; replaying the issue step and the processor webhook never creates a second charge. | **MISSING** |
| PAY-004 | Payment events, refunds and payouts reconciled | Deliver Stripe test webhooks twice and out of order for payment, refund, dispute and an R01 return, then a payout; invoice states, fees and the payout reconciliation match Stripe's balance transactions exactly. | **MISSING** |
| PAY-005 | Card lifecycle and expiry | Set a test card to expire before renewal; the customer receives the expiry email 14 days ahead, updates the card through the link, and the renewal charges the new card. | **MISSING** |
| PAY-006 | No-code payment links | Create a monthly-plan link with a 14-day trial, open it signed out, subscribe with a test card, and see the customer, subscription and link attribution appear; deactivate the link and see it refuse a second visitor. | **MISSING** |

## Target: Dunning and recovery

| # | What a person can do | Test target | Status |
| --- | --- | --- | --- |
| DUN-001 | Smart retries | Fail renewals with insufficient-funds, do-not-honor and stolen-card codes on a test clock; the first two retry on schedule and one recovers, the stolen card stops at once, and no invoice is retried beyond the limit. | **MISSING** |
| DUN-002 | Dunning sequences | Run a four-email, 21-day dunning policy on a failing card; each email arrives on schedule with a working update link, updating the card mid-sequence stops the sequence and pays the invoice, and a second customer ends restricted after day 21; a customer on the enterprise plan follows a second, invoice-only policy with different timing and is never restricted. | **MISSING** |
| DUN-003 | Trial, renewal and payment notices | Run a trial to conversion and a failed payment on a test clock and see each notice arrive once with the right figures; renew on a Stripe test card that requires authentication, receive the authentication-required notice, confirm on the linked page and see the invoice paid once; switching one notice off stops only that notice. | **MISSING** |
| DUN-004 | Recovery reporting | After a test-clock run with known outcomes, the recovery report's counts and dollar figures equal the payments and failures recorded. | **MISSING** |

## Target: Receivables and collections

| # | What a person can do | Test target | Status |
| --- | --- | --- | --- |
| AR-001 | Collections cadences sent from Nectar | Run a Net 30 invoice past due; reminders go out on days −3, +1, +7 and +15; a promise to pay pauses them until its date; a dispute on one line stops reminders for that line only; payment stops the cadence. | **PARTIAL** |
| AR-002 | Cash application | Feed a Plaid sandbox account with a wire paying three invoices, an ACH credit with a remittance email, a short payment and an unknown deposit; the first two apply automatically, the short payment leaves the right balance and the unknown deposit waits in the queue. | **PARTIAL** |
| AR-003 | Disputes and chargebacks | Trigger a Stripe test dispute; Nectar opens a dispute with its deadline, assembles evidence from the invoice, usage and delivery log, submits it, and records the won outcome with the funds returned. | **MISSING** |
| AR-004 | Write-offs and bad debt | Write off a 120-day balance, see it leave ageing, post to QuickBooks as bad debt and stop reminders; then record a partial recovery and see the reversal. | **MISSING** |
| AR-005 | Accounts-payable portal submission | Submit an invoice to a Coupa test supplier portal and to a Purse installation; each portal's received, approved and paid states appear on the invoice. | **MISSING** |

## Target: Customer portal

| # | What a person can do | Test target | Status |
| --- | --- | --- | --- |
| PORT-001 | Customer billing portal | A billing contact signs in by link, pays an open invoice by ACH, adds a contact and uploads an exemption certificate; another customer's contact can see none of it. | **MISSING** |
| PORT-002 | Usage, credits and upcoming charges in the portal | Stream usage and refresh the portal; usage, credit balance and the upcoming invoice match the operator view and the next issued invoice. | **MISSING** |
| PORT-003 | Self-service plan changes within policy | A customer upgrades with a proration preview and pays the difference, a downgrade below the contract minimum becomes a request, and a cancellation completes through the `SUB-005` flow. | **MISSING** |
| PORT-004 | Payment methods in the portal | Replace an expiring card and add a verified ACH account in the portal; the next invoice charges the new default. | **MISSING** |
| PORT-005 | Embedded portal and branded domain | Open the portal embedded in a sample app with a server-signed session and on `billing.example.com`; both show only that customer's data, and an expired session is refused. | **MISSING** |
| PORT-006 | Customer-facing language | Set a customer to Spanish; their invoice email, hosted page, PDF, portal and dunning email render in Spanish with the same figures as the English version; add a French translation file and see a French customer's pages switch with no code change; a missing string fails the check instead of showing a key. | **MISSING** |

## Target: Tax

| # | What a person can do | Test target | Status |
| --- | --- | --- | --- |
| TAX-001 | US sales tax through a tax provider | With the Avalara sandbox, bill customers in Texas, New York and Oregon for SaaS; each line's tax matches AvaTax's response, the issued invoices are committed in AvaTax, and a credit note reverses its share. | **PARTIAL** |
| TAX-002 | Exemption certificates | Upload a Texas resale certificate for a customer, bill them tax-free in Texas but taxed in New York, let the certificate expire on a test clock and see the exception and reminder. | **PARTIAL** |
| TAX-003 | Tax reports for filing | After a quarter of test-clock billing, the tax report's totals per state equal the sum of invoice tax lines less credits, and equal the tax provider's committed transactions. | **MISSING** |
| TAX-004 | Economic-nexus monitoring | Bill a test customer base so that Colorado reaches 80% and then 100% of its threshold; the owner receives one warning at each step naming the state, the measurement period and the figures, which equal the issued invoices in that state. | **MISSING** |

## Target: Accounting and revenue

| # | What a person can do | Test target | Status |
| --- | --- | --- | --- |
| BOOK-001 | QuickBooks Online, Xero and Pantry sync | Run a month of billing against a QuickBooks Online sandbox company and a Xero demo company; every record appears once with the right accounts, re-running the sync creates nothing new, and the reconciliation report shows Nectar's and the ledger's AR balances equal. | **MISSING** |
| BOOK-002 | NetSuite and Sage Intacct sync | Sync a month of two-entity billing to a NetSuite sandbox with subsidiaries; invoices, payments and journals land in the right subsidiary and the AR balance agrees. | **MISSING** |
| REV-001 | ASC 606 revenue schedules | Bill an annual $12,000 plan in advance, monthly usage and a prepaid credit block; the schedules recognise $1,000 a month, usage in its month and credits as consumed, and the deferred-revenue waterfall ties to invoices issued. | **MISSING** |
| REV-002 | Revenue close and journal export | Close September, then issue a credit note dated in September; the closed period is unchanged, the credit posts in October, and the roll-forward ties opening balance + billings − revenue = closing balance. | **MISSING** |

## Target: Reporting and analytics

| # | What a person can do | Test target | Status |
| --- | --- | --- | --- |
| RPT-001 | SaaS metrics | Move in an 18-month Stripe test account through the live connection (`MOVE-006`) and, separately, through the uploaded capture (`NEC-16`), and adopt its subscriptions; with no data written except through those move-in doors and later billing, the MRR, movements, churn, net and gross retention and cohort tables for every pre-cutover month equal an independent computation over the Stripe objects captured, and equal Stripe's "Subscription metrics per month" report for the same account except for listed definition differences, each explained; the months after cutover continue the same series without a break; each figure drills to the subscriptions that make it up. | **MISSING** |
| RPT-002 | Financial reports | After a test month, the billings report equals issued invoices, collections equals settled payments, AR equals the sum of open balances, tax collected equals invoice tax lines less credits, credit balances equal the customer balance ledgers, and unbilled usage equals rated events not yet invoiced; a scheduled report arrives by email with the same figures. | **PARTIAL** |
| RPT-003 | Drill-through from every figure | From the MRR, billings and AR reports, drill one figure down to an invoice line and from there to its usage events; the totals at each level agree. | **PARTIAL** |
| RPT-004 | Warehouse and BI export | Sync to a BigQuery test dataset and recompute MRR and AR from the synced tables; they equal Nectar's reports. | **MISSING** |

## Target: CRM, contracts and workflow integrations

| # | What a person can do | Test target | Status |
| --- | --- | --- | --- |
| CRM-001 | Closed-won deals become subscriptions | Close a deal in a Salesforce developer org and in Orbit; each creates one draft subscription matching the quote, approval starts billing, and the account shows MRR and an overdue flag after a missed payment. | **MISSING** |
| CRM-002 | Signed order forms and contracts as inputs | Complete a Docusign sandbox envelope and an Inkwell envelope; each attaches to its customer and opens a setup proposal quoting the document. | **PARTIAL** |
| INT-001 | Chat alerts and approvals | Fail a payment and prepare a bill run with an exception; each posts one message to a Slack test workspace and to Nook with a link that opens the item for a signed-in approver only. | **MISSING** |
| INT-002 | Workflow automation and support context | A Zapier test zap fires on `invoice.paid`; HappyToHelp shows the customer's plan and open balance on a ticket through a scoped read credential that cannot change billing. | **MISSING** |
| INT-003 | Team email notifications | With the finance lead subscribed to disputes and mismatched payments, trigger a Stripe test dispute and a short payment; the finance lead receives one email each through the Postmark sandbox with a working link, and an unsubscribed member receives none. | **MISSING** |

## Target: Move-in from every incumbent

| # | What a person can do | Test target | Status |
| --- | --- | --- | --- |
| MOVE-001 | Chargebee move-in | Import from a Chargebee test site, shadow-rate a month and compare with Chargebee's invoices line by line, then adopt one subscription from an unbilled period and see Chargebee's renewal cancelled and no duplicate invoice. | **MISSING** |
| MOVE-002 | Recurly move-in | Import from a Recurly sandbox, shadow-compare a month and adopt one subscription with no duplicate charge. | **MISSING** |
| MOVE-003 | Maxio move-in | Import a Maxio test site's metered and quantity components, shadow-compare a month and adopt one subscription with no duplicate charge. | **MISSING** |
| MOVE-004 | Orb and Metronome move-in | Import an Orb test account's plans, credits and three months of events; replaying them reproduces Orb's invoices within the listed rounding differences, each explained. | **MISSING** |
| MOVE-005 | Payment methods move with the customer | Move in from Stripe Billing and charge the existing test payment method with no customer action; then map a Braintree-to-Stripe token export file and charge a migrated card. | **MISSING** |
| MOVE-006 | Live Stripe connection and two-sided cutover | Connect a Stripe test account, let it change during the shadow run, adopt a subscription and advance the test clock; Stripe issues no further invoice, Nectar issues the next one, and the customer is charged once. | **PARTIAL** |
| MOVE-007 | Moved-in history counts from day one | Move in an 18-month Stripe test account with an annual plan paid in advance four months before cutover; the customer record shows its Stripe invoices, payments and refunds; the MRR series and billings report start 18 months back and equal the Stripe objects; opening deferred revenue for the annual plan equals eight months of its fee and recognises monthly after cutover; no moved-in invoice can be approved, issued or charged. | **PARTIAL** |

## Target: Roles, security and governance

| # | What a person can do | Test target | Status |
| --- | --- | --- | --- |
| GOV-001 | Billing roles | Sign in as each role and crawl every action and door as `NEC-15` does; each role reaches exactly its capabilities, and a support agent's $500 credit succeeds while a $600 credit is refused. | **PARTIAL** |
| GOV-002 | Approval policies and separation of duties | Set a $1,000 two-person limit; a $1,500 credit prepared by one operator cannot be approved by the same person and issues after a second approver; a $900 credit needs one. | **PARTIAL** |
| GOV-003 | Single sign-on and provisioning | Configure an Okta developer tenant; a SCIM-created user signs in by SAML with the mapped role, and deprovisioning ends their sessions within a minute; with `GOV-007` required, an assertion without a multi-factor authentication context is refused. | **MISSING** |
| GOV-004 | Durable audit trail | Perform each billing action through the API and forms, read `/app/audit` and the issued invoice's audit events, and find `nc_audit` complete in the exported archive. | **LOCAL PROVEN** |
| GOV-005 | Personal-data erasure with financial retention | Erase a former customer's contacts; their names and emails disappear from screens, exports and the archive, issued invoices remain with the legal name the law requires, and a receipt lists what changed. | **MISSING** |
| GOV-006 | Provider secret custody | Connect Stripe, Avalara and QuickBooks, export the installation and search logs, the archive and the database for the planted secrets; none appears in clear, and rotating each keeps billing working. | **PARTIAL** |
| GOV-007 | Required multi-factor sign-in | The owner turns on "require multi-factor" for finance operators; a finance operator signed in by email link is held at enrolment and every door (page, form post, JSON API, download) refuses them until they enrol a TOTP factor and present a code; a refund approval 20 minutes later asks for a fresh code and is refused with a wrong one; the owner then requires it installation-wide and an accountant is held the same way; enrolling a passkey works in a WebAuthn virtual authenticator; resetting the operator's factor ends their open sessions at once; the audit trail lists each step. | **MISSING** |

## Target: Mobile and operations

| # | What a person can do | Test target | Status |
| --- | --- | --- | --- |
| MOB-001 | Every operator screen works on a phone | `tests/nectar/journey.mjs`, after a full billing cycle at 1440 pixels, opens every main screen at 390 × 844 and fails if any scrolls sideways or lacks its heading, then records a payment through the receivables form at that width. | **LOCAL PROVEN** |
| MOB-003 | Customer-facing pages and emails work on a phone | In a 390 × 844 touch browser against Stripe test mode, open an issued invoice's emailed link and pay it with a test card, open another and pay by test ACH; complete a checkout from a payment link; open a dunning email's update link and replace a failing card, which pays the invoice; in the portal, change plan with its proration preview and download a receipt. Every step completes, every page fails the test if `scrollWidth` exceeds the viewport, and each delivered email's HTML rendered at 390 pixels has no sideways scroll and a tappable primary button. | **MISSING** |
| MOB-002 | Nectar for iOS and Android | On iOS and Android test devices, receive a push for a failed payment and an exception draft, open each, approve the draft (refused for a role without approval) and see the audit name the person and device. | **MISSING** |
| OPS-001 | Measured capacity and unattended jobs | Seed 10,000 subscriptions, run a billing day with the Worker restarted mid-run, and see every invoice issued and charged exactly once within 15 minutes, with the timing recorded in `seed.json` limits. | **MISSING** |

## Push further with agents

| # | What a person can do | Test target | Status |
| --- | --- | --- | --- |
| AGENT-001 | Continuous revenue assurance | Plant five mismatches (an unbilled ramp step, an over-billed seat, a feature left on after cancellation, a missing true-up and an unapplied credit); the agent opens five evidenced cases with owners, re-checks after each approved fix, closes them, and changes nothing without approval. | **PARTIAL** |
| AGENT-002 | Simulate the fix and explain it to the customer | For a planted over-billing, the agent proposes a credit note with its tax and revenue effect and a cited email; approval issues the credit and sends the email once; a rejection changes nothing. | **PARTIAL** |
| AGENT-003 | Collections that resolve the cause of nonpayment | Plant a bounced invoice, a missing PO and an expired card on three overdue accounts; the agent identifies each cause, sends the right request within its limits, and each account pays after the fix; it never contacts a disputed account. | **PARTIAL** |
| AGENT-004 | Price-change simulation with customer explanations | Simulate moving from per-seat to usage pricing over six months of history; the per-customer deltas equal a re-rating through the engine, and approving one cohort schedules exactly those changes with their notices. | **PARTIAL** |
| AGENT-005 | Migration followed through to the first settled cycle | Move in a test Stripe account with three planted differences; the agent explains each, the owner adopts, and after the first cycle the agent's report shows one invoice and one charge per subscription, matching both processors. | **PARTIAL** |
| AGENT-006 | Contract-to-billing setup | Give the agent a three-year order form with a ramp, a commitment and an uplift; its proposal quotes each clause, the term preview matches a hand calculation, and approving it starts billing with no manual edits. | **PARTIAL** |
| AGENT-007 | Cited billing answers for staff and customers | Ask ten scripted questions as an operator and as a customer; every figure in each answer matches a cited record, a question about another customer's data is refused, and a suggested credit appears only as a proposal. | **MISSING** |
| AGENT-008 | Month-end close tie-out | Plant a payout missing one fee, an unsynced credit note and a tax commitment failure; the close packet lists all three with causes, approved fixes clear them, and the accountant closes the period. | **MISSING** |

## What the proposal's acceptance asks, and where it is proven

- **Duplicate usage does not double-bill:** a repeated event id changes nothing (`NEC-05`); a billed event is marked inside the issuing transaction and an issued period is never drafted again (`NEC-10`).
- **A timezone boundary and a late event remain explainable:** 23:30 on 31 July in Los Angeles belongs to July even though it is 1 August in UTC (`NEC-06`); an event for an invoiced month bills next month as a late-usage line naming its period and event id (`NEC-09`).
- **Proration agrees with the approved preview:** `NEC-08` compares the bill run's fixed, seat and discount lines with the approved preview line for line.
- **Source changes invalidate approval:** a usage event arriving after approval stops that invoice at finalising while the unchanged one issues (`NEC-10`); a proposal prepared against older records is refused (`NEC-14`).
- **Credits and allocations preserve the receivable:** over-credit and over-allocation are refused inside the batch and the invoice and customer ledgers balance (`NEC-11`).
- **Imported subscriptions cannot charge:** moved-in subscriptions are shadow drafts that cannot be approved, and adoption refuses any cutover inside a period Stripe billed (`NEC-16`). Nectar has no payment collection path at all.
- **Restore retains the calculation evidence:** the journey exports the populated installation, refuses a corrupt and a second import, restores into a fresh clone, exports again with every portable row equal, and reads each issued invoice's calculation fingerprint back from the restored app.

## Evidence

Worked figures from the tests: Northwind's July invoice bills $499.00 + 5 seats × $30.00, a 10% contract discount of −$49.90 and −$15.00 (rounded per line), and 3,346,778.5 events × $0.0004 = $1,338.7114 → $1,338.71, subtotal $1,922.81, tax 8.25% = $158.632 → $158.63, total $2,081.44; Pinecrest's trial ends 29 July, so 17 of 31 days of $499.00 bill $273.65 with no tax for its exemption.

`rer verify` runs the Worker checks and every acceptance flow, and CI runs it on every change. The browser journey and restore round trip run from a disposable fresh clone with `NECTAR_TEST_CHECKOUT=1 pnpm run test:journey`. Hosted operation is not claimed.
