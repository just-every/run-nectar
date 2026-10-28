# Nectar Agent surface (draft)

Draft Agent surface for Nectar, written by ct on 28 October 2026 to the contract standard's section 13. It maps every Core clause of `CONTRACT.md` at main `24303c4b9cfe4d055c4683397ebd7971bb861efb` (130 Core clauses). It is not part of CONTRACT.md yet: the seed's contract cleanup folds the `### Agent surface` area below into CONTRACT.md as the last area under Target clauses, and the rows under "Status rows" into its Status table. Old clauses whose text fixes what happens to an agent's step: NEC-14, SET-001, CAT-001, CAT-004, CAT-005, CUS-002, USE-004, SUB-003, SUB-005, DEV-005, INV-005, INV-006, PAY-002, PAY-003, PAY-005, PAY-007, DUN-001, DUN-002, AR-004, PORT-005, INT-003, GOV-005, GOV-007, AGENT-001, AGENT-002, AGENT-003, AGENT-004, AGENT-005, AGENT-006, AGENT-007, AGENT-008, AGENT-009, AGENT-010; the cleanup rewords them as the class the step carries.

### Agent surface

**Specialist: Billing controller.** It turns signed commercial terms and metered usage into exact invoices, follows collections and corrections, and ties billing, customer access, tax and revenue together for the business.

Inherits BASE-AGENT-001 to BASE-AGENT-013. The company's policy decides every call.

**How Nectar computes each class.**

- *standard:* reads, estimates, reversible internal settings and drafts that change no charge, standing authority or running service; facts identify the affected items. Forecast revenue and assumed provider costs are figures, not money moved.
- *external:* a message, document, link, event payload or provider request reaches outside the business. Facts carry recipient count and counterparty: known for an on-record customer, vendor or trusted domain; new otherwise; public for an open payment or invoice link. Internal recipients and endpoints do not trigger this class. Exposure is computed from the resolved destination and saved visibility, including protected content actually sent.
- *money:* published prices, discounts, commitments, billable subscription changes, issued charges, credits, payments, allocations, refunds, balance applications and write-offs change what the business charges, pays or owes. Facts carry exact amount, currency and counterparty; cohort changes carry each affected customer and amount. Merely rating, quoting, replaying or reporting those figures does not trigger money.
- *commitment:* applying quoted commercial terms, issuing an invoice, accepting a binding offer, submitting relied-on dispute evidence, confirming exact case agreement or closing a revenue period binds the business or records a sign-off others rely on. Facts carry the exact basis, value and counterparty where applicable.
- *gated:* an outside processor, identity, tax or accounting provider returns a step it keeps for a person, such as consent in that person's account, hosted card entry, business verification or terms in that person's name. Facts carry provider and step. An existing complete provider authorization without such a step does not trigger gated; the provider response can add it during a call.
- *access:* invitations, membership, roles, application and agent credentials, SSO provisioning, portal sessions and webhook subscriptions change continuing authority. Facts carry affected people or grant targets and whether authority widens or narrows, compared with the native current target, not a caller's description.
- *security:* credential creation, rotation and revocation, provider connections, SSO protection, factor requirements and resets, portal origin protection and webhook secret custody change protective settings or handle secrets. Facts name the setting or credential reference, never the secret value.
- *destructive:* erasure, due financial removal, invoice voiding and publication of an append-only note cannot be undone in Nectar. Facts name affected items and counts; a correcting record is not Undo of an immutable original. Drafting these actions carries no destructive class.
- *sensitive:* the content actually read, written, returned or sent includes health, ID, bank, card or payroll numbers, for example an entity EIN, an exemption document's tax ID or virtual-account funding instructions. Facts carry record count and data kind. Names, billing emails, balances, opaque processor references and masked last-four summaries alone do not trigger it. Arbitrary notes, metadata and source files are examined as content, never trusted as classification instructions.
- *live:* activating a meter or entitlement rule, applying subscription service changes, enabling invoice/collection/retry/retention schedules or changing an active public payment link changes a running service's behavior. Facts name the affected service and effective time. Drafts and read-only comparisons do not trigger live.

Nectar uses no accounts class: its jobs connect existing merchant services; creation of an outside service account belongs to that service. In the table, `a or b` selects a class per call, `a · b` always declares both, and `(+ c)` adds c when its test holds. Today names the native backing action or route, not an existing MCP tool; `none` means the native job is absent. Partial backing is stated explicitly.

| Tool | Does | Core clauses | Risk class | Today |
| --- | --- | --- | --- | --- |
| `nectar.business.get` | Read business and entity billing configuration | NEC-01, SET-001 | standard (+ sensitive) | `GET /api/nectar/business`, `GET /api/nectar/billing-entities` |
| `nectar.business.configure` | Save reversible legal identity, invoice presentation and billing defaults | NEC-01, INV-004 | standard (+ sensitive) | `business.configure` |
| `nectar.entities.create` | Add a legal billing entity and its routes | SET-001 | standard (+ sensitive) | `entity.create` |
| `nectar.entities.update` | Revise an entity's legal and processor/ledger routing facts | SET-001 | standard (+ sensitive) | `entity.update` |
| `nectar.customers.search` | Find a customer by any contracted billing reference | NEC-02, CUS-001 | standard | `GET /api/nectar/customers` |
| `nectar.customers.get` | Read one customer, children and permitted billing sources | CUS-001, CAT-009, PORT-001 | standard (+ sensitive) | `GET /api/nectar/customers/{id}`; portal projection partial |
| `nectar.customers.create` | Create a customer with external identity and billing language | NEC-02, PORT-006 | standard (+ sensitive) | `customer.create` |
| `nectar.customers.update` | Change a customer's address, language and invoice fields | NEC-02, INV-004, PORT-001, PORT-006 | standard (+ sensitive) | `customer.update`; portal edits absent |
| `nectar.contacts.add` | Add a billing contact under the customer's exact identity | NEC-02, PORT-001 | standard (+ sensitive) | `contact.add`; portal edits absent |
| `nectar.hierarchies.configure` | Set parent/payer relationships and consolidated billing | CAT-009 | money · commitment | `hierarchy.configure`; shared-credit execution absent |
| `nectar.notes.list` | Read dated record notes and their mentions | CUS-002 | standard (+ sensitive) | `GET /api/nectar/notes/{kind}/{id}` |
| `nectar.notes.add` | Publish one immutable note with resolved member mentions | CUS-002 | destructive (+ external) (+ sensitive) | `note.add`; current mentions internal |
| `nectar.metadata.get` | Read an object's exact metadata and revision | DEV-005 | standard (+ sensitive) | `GET /api/nectar/metadata/{kind}/{id}` |
| `nectar.metadata.replace` | Replace a reversible metadata map at its revision | DEV-005 | standard (+ sensitive) | `metadata.write` |
| `nectar.api.describe` | Read native API versions, schemas and call mappings | DEV-002, DEV-006 | standard | `GET /api/nectar/openapi`, `API.md` |
| `nectar.catalog.get` | Read versioned products, prices, meters and features | NEC-03, CAT-001, CAT-002, CAT-008 | standard | `GET /api/nectar/catalog` |
| `nectar.products.create` | Create a product record | NEC-03 | standard | `product.create` |
| `nectar.prices.prepare` | Draft an immutable catalog price revision | NEC-03, CAT-001, CAT-002, CAT-008 | standard | `price.create` (v2+ requests); first-version draft absent |
| `nectar.prices.publish` | Publish exact catalog price terms | NEC-03, CAT-001, CAT-002, CAT-008 | money | `price.decide`; first version in `price.create` |
| `nectar.prices.retire` | Withdraw a price from new sales without altering existing bills | NEC-03 | money | `price.retire` |
| `nectar.coupons.create` | Publish coupon terms | CAT-005 | money | `coupon.create` |
| `nectar.promotions.create` | Publish a bounded redemption code for a coupon | CAT-005 | money | `promotion.create` |
| `nectar.currency.record` | Record a sourced daily reporting rate | CAT-008 | standard | `currency.rate.record` |
| `nectar.meters.prepare` | Draft a metric aggregation, dimensions or parsed read-only SQL | USE-002, NEC-03 | standard | `meter.prepare`, `meter.create` |
| `nectar.meters.preview` | Evaluate a draft metric on recorded historical events | USE-002 | standard (+ sensitive) | `meter.preview` |
| `nectar.meters.activate` | Activate an exact metric version without rewriting old prices | USE-002 | live | `meter.activate` |
| `nectar.subscriptions.get` | Read service state, dated items, signed terms and history | NEC-04, SUB-001, CAT-003 | standard (+ sensitive) | `GET /api/nectar/subscriptions/{id}` |
| `nectar.subscriptions.prepare` | Draft new service, add-ons, quantities or an executed-order setup | NEC-04, NEC-08, CAT-001, CAT-003, CAT-006, AGENT-006, NEC-14 | standard (+ sensitive) | `proposal.create`, `change.prepare`, `contract.prepare`, `setup.resolve` |
| `nectar.subscriptions.preview` | Rate an exact proposed service change and full finite term | NEC-07, NEC-08, SUB-002, AGENT-006 | standard (+ sensitive) | `plan.change.prepare`, `change.prepare`, proposal preview; issued combinations partial |
| `nectar.subscriptions.apply` | Install the exact quoted service and price change | NEC-04, NEC-08, CAT-001, CAT-003, CAT-006, SUB-002, AGENT-006 | money · commitment · live | `proposal.decide`, `change.decide`, `contract.decide`, `plan.change.decide`, `subscription.create`, `subscription.addon` |
| `nectar.subscriptions.pause` | Pause service with dated charge and entitlement effects | SUB-003, PORT-003 | money · commitment · live | `subscription.pause`; customer door absent |
| `nectar.subscriptions.resume` | Resume service on the stated date | SUB-003, PORT-003 | money · commitment · live | `subscription.resume`; customer door absent |
| `nectar.subscriptions.cancel` | End service now or at its actual term boundary | SUB-003, SUB-004, PORT-003 | money · commitment · live | `subscription.cancel`, `subscription.cancel.decide`; renewal-link cancellation only for customers |
| `nectar.subscriptions.reactivate` | Reactivate service with dated terms and history | SUB-003, SUB-005 | money · commitment · live | `subscription.reactivate`; win-back POST in `src/nectar/retention-offers.ts` |
| `nectar.trials.extend` | Extend the exact trial and first-charge date | CAT-005 | money · commitment · live | `trial.extend` |
| `nectar.renewals.prepare` | Draft term length, uplift and notice timing | SUB-004 | standard | `term.prepare` |
| `nectar.renewals.apply` | Install exact renewal terms on active service | SUB-004 | money · commitment · live | `term.decide` |
| `nectar.retention.prepare` | Draft save and win-back terms and audience | SUB-005 | standard | `retention.policy.prepare` |
| `nectar.retention.apply` | Activate the exact save and win-back schedule | SUB-005 | money · commitment · live | `retention.policy.decide` |
| `nectar.pricing.simulate` | Replay recorded periods and compare a proposed price cohort | CAT-007, AGENT-004 | standard (+ sensitive) | `proposal.create` pricing simulation, `src/nectar/pricing-replay.ts` |
| `nectar.pricing.schedule` | Apply the frozen cohort price migration and effective dates | CAT-007, AGENT-004 | money · commitment · live | `proposal.decide` |
| `nectar.usage.submit` | Durably record idempotent usage events for their native period | NEC-05, USE-001 | standard (+ sensitive) | `usage.submit`; 5,000-event batch, measured-scale pipeline absent |
| `nectar.usage.inspect` | Read raw events, period totals, gaps and late events | NEC-06, USE-006 | standard (+ sensitive) | `GET /api/nectar/usage/inspect` |
| `nectar.controls.record` | Record a sender's daily meter control totals | USE-007 | standard | `usage.control` |
| `nectar.controls.reconcile` | Compare ingested totals and record an exact discrepancy decision | USE-007 | commitment | `usage.acknowledge`, `src/nectar/reconciliation.ts` |
| `nectar.corrections.preview` | Replay historical usage or an invoice fix without posting it | USE-004, AGENT-002 | standard (+ sensitive) | `usage.correction.preview`, `invoice.refund.preview` |
| `nectar.corrections.prepare` | Freeze a cited adjustment and its customer explanation | USE-004, NEC-14, AGENT-002 | standard (+ sensitive) | `usage.correction.prepare`, `proposal.credit.prepare`, `proposal.create` |
| `nectar.corrections.apply` | Post only the exact current-basis financial delta | USE-004, AGENT-002, AGENT-009 | money · commitment | `usage.correction.decide`, `proposal.decide`; broader case resolution absent |
| `nectar.upcoming.get` | Read same-engine current usage, remaining credit and upcoming charges | USE-006, PORT-002, CAT-003, CAT-004 | standard (+ sensitive) | `GET /api/nectar/subscriptions/{id}/upcoming`, portal upcoming and prepaid views |
| `nectar.alerts.configure` | Set usage, spend or commitment crossings and their actions | USE-005 | live | none; entitlement quota crossings only |
| `nectar.entitlements.get` | Explain a feature's current grant, limit and meter basis | NEC-13, ENT-001, ENT-002 | standard | `GET /api/nectar/entitlements/{customer}` |
| `nectar.entitlements.configure` | Apply an exact product feature or quota/grace rule | ENT-002, NEC-03 | live | `feature.grant`, `feature.policy` |
| `nectar.billruns.list` | List bill runs and their period states | NEC-09 | standard | `GET /api/nectar/runs` |
| `nectar.billruns.prepare` | Draft deterministic subscription invoices, comparisons and exceptions | NEC-07, NEC-09, CAT-002 | standard (+ sensitive) | `billrun.prepare` |
| `nectar.invoices.prepare_manual` | Draft one standalone invoice from exact catalog or custom lines | CAT-006 | standard (+ sensitive) | `invoice.manual` |
| `nectar.hierarchies.prepare_invoice` | Draft a consolidated invoice with per-child sections | CAT-009 | standard (+ sensitive) | `hierarchy.invoice.prepare` |
| `nectar.billruns.get` | Read draft lines, exact input basis and exceptions | NEC-09, NEC-10 | standard (+ sensitive) | `GET /api/nectar/runs/{id}` |
| `nectar.invoices.issue` | Issue an exact numbered invoice and consume its source once | NEC-10, INV-001, CAT-006 | money · commitment | `invoice.finalise`; prerequisite native decision in `invoice.approve` |
| `nectar.automation.configure` | Activate an invoice-run schedule with exact scope | INV-001 | live | `invoice.automation.prepare`, `invoice.automation.decide` |
| `nectar.invoices.get` | Read issued lines, tax, allocations and immutable calculation evidence | NEC-10, INV-003, INV-004, PORT-001 | standard (+ sensitive) | `GET /api/nectar/invoices/{id}`, portal invoice/PDF routes |
| `nectar.documents.read` | Download invoices, receipts, certificates or cited source documents | NEC-13, INV-003, INV-004, PORT-001 | standard (+ sensitive) | `src/nectar/invoice-pdf.ts`, `GET /api/nectar/payments/{id}/receipt`, access-checked downloads |
| `nectar.invoices.send` | Deliver an invoice or receipt to the resolved recipients | INV-002 | standard or external (+ sensitive) | none |
| `nectar.invoices.void` | Append an immutable void and preserve original issued evidence | INV-005 | money · destructive | `invoice.void.prepare`, `invoice.void`; supported cases partial |
| `nectar.credits.prepare` | Draft a numbered invoice credit or balance concession | NEC-11, INV-005, INV-006 | standard | `credit.prepare`, `balance.prepare` |
| `nectar.credits.issue` | Issue exact credit or goodwill value against the current basis | NEC-11, INV-005, INV-006 | money | `credit.issue`, `credit.approve`, `balance.goodwill`, `balance.approve` |
| `nectar.balances.get` | Read customer balances and the exact ledger components | INV-006, CAT-004 | standard | `GET /api/nectar/customers/{id}/balance`, prepaid routes |
| `nectar.balances.apply` | Apply existing customer value once to invoice debt | INV-006 | money | `balance.apply` |
| `nectar.payments.list` | Read payments, attempt states and receipts | NEC-11, PAY-004, CUS-001 | standard | `GET /api/nectar/payments`, native and automatic collection routes |
| `nectar.payments.record` | Record evidenced external cash without claiming processor settlement | NEC-11, AR-002 | money | `payment.record`, `payment.ach_evidence.record` |
| `nectar.payments.allocate` | Allocate recorded cash to exact invoice balances | NEC-11, AR-002 | money | `payment.allocate` |
| `nectar.payments.prepare` | Freeze one native or automatic collection's invoice and method basis | PAY-003, PAY-008, INV-007 | standard | `collection.prepare`, `automatic.collection.prepare`; customer schedules absent |
| `nectar.payments.collect` | Collect the exact owed amount through its merchant account | PAY-003, PAY-008, INV-007 | money · external (+ gated) | `collection.confirm`, `automatic.collection.decide`; hosted partial/scheduled payments absent |
| `nectar.payments.reconcile` | Read the original provider attempt and record its actual outcome | PAY-003, PAY-004, PAY-008 | external (+ gated) | `collection.reconcile`, `automatic.collection.reconcile` |
| `nectar.cash.allocate` | Apply processor cash-balance funds to an exact invoice | PAY-007, AR-002 | money · external (+ gated) | `processor.cash.allocate`; virtual-account instructions absent |
| `nectar.cash.return` | Return an exact unapplied balance to its sender | PAY-007 | money · external (+ gated) | `processor.cash.return.execute` |
| `nectar.refunds.prepare` | Freeze an invoice, customer-balance or unused-prepaid refund | INV-005, INV-006, CAT-004, CAT-012 | standard | `invoice.refund.prepare`, `prepaid.refund.prepare`, `balance.prepare` |
| `nectar.refunds.execute` | Return exact cash through its original merchant processor | INV-005, INV-006, CAT-004, CAT-012 | money · external (+ gated) | `invoice.refund.execute`, `prepaid.refund.decide`; `balance.return` records an external transfer only |
| `nectar.refunds.reconcile` | Read the original refund's actual provider outcome | INV-005, CAT-004, CAT-012 | external (+ gated) | `invoice.refund.reconcile`, `prepaid.refund.reconcile` |
| `nectar.refunds.request` | Record a support or own-customer refund intake without reserving money | CAT-012, PORT-001 | standard | `prepaid.refund.request`, `POST /portal/prepaid-refund.request` |
| `nectar.prepaid.prepare` | Draft paid or promotional credit terms and top-up authorization | CAT-004, CAT-010 | standard (+ sensitive) | `prepaid.prepare`, `prepaid.topup.prepare` |
| `nectar.prepaid.apply` | Install exact credit terms and signed top-up authority | CAT-004, CAT-010 | money · commitment · live | `prepaid.decide`, `prepaid.topup.decide` |
| `nectar.prepaid.purchase` | Charge and fund one prepaid block at actual capture time | CAT-004, CAT-011 | money · external (+ gated) | `prepaid.purchase.prepare`, `prepaid.funding.confirm`, `prepaid.settle`; real top-up proof missing |
| `nectar.prepaid.topup` | Fund one threshold crossing from its exact current authorization | CAT-010, CAT-011 | money · external (+ gated) | `prepaid.topup.run` |
| `nectar.prepaid.revoke` | End future top-ups without changing completed funding | CAT-010 | money · commitment · live | `prepaid.topup.revoke`, `prepaid.consent.revoke` |
| `nectar.methods.list` | Read safe card/ACH summaries and mandate evidence | CUS-001, PORT-004, PAY-005 | standard (+ sensitive) | customer record and portal payment-method views; safe summaries only today |
| `nectar.methods.refresh` | Read the merchant processor's current safe method facts | CUS-001, PAY-005 | external (+ gated) | `customer.payment_methods.refresh` |
| `nectar.methods.prepare` | Prepare method capture, replacement, default change or removal | PAY-002, PORT-004 | standard | `checkout.setup.prepare`, `portal.method.prepare` |
| `nectar.methods.change` | Request an exact processor method change, returning any hosted step | PAY-002, PORT-004 | external (+ gated) | `POST /portal/payment-methods/start`, `/action`, `/finish`; customer interactive steps remain screens |
| `nectar.links.create` | Draft an unexposed hosted subscription or one-time payment link | PAY-006 | standard | `payment_link.create` |
| `nectar.links.activate` | Publish exact checkout terms at a public link | PAY-006 | money · commitment · external · live | `payment_link.activate` |
| `nectar.links.deactivate` | End new checkout use without changing completed sales | PAY-006 | live | `payment_link.deactivate` |
| `nectar.retries.configure` | Activate an exact retry table, plan/segment selection and timing | DUN-001 | live | `retry.policy.configure`, `retry.segment.assign`; native per-invoice authority still required today |
| `nectar.retries.collect` | Execute a due attempt on the original payment identity | DUN-001 | money · external (+ gated) | `src/nectar/retry-jobs.ts`; current consented slice only |
| `nectar.dunning.configure` | Activate a failure sequence and its final service action | DUN-002 | live | `dunning.policy.create`, `dunning.enroll`; unattended sequence absent |
| `nectar.notices.prepare` | Draft exact collection, renewal, failure or expiry wording | NEC-12, DUN-003, PAY-005, AGENT-003 | standard (+ sensitive) | `reminder.prepare`, `dunning.mail.prepare`, `card.expiry.prepare`; general notices absent |
| `nectar.notices.send` | Deliver an exact notice or correction explanation | AR-001, DUN-002, DUN-003, PAY-005, CAT-012, AGENT-002, AGENT-003, INT-003 | standard or external (+ sensitive) | `dunning.mail.send`, `card.expiry.send`, cadence/correction/refund mail modules; general notices absent |
| `nectar.collections.get` | Read aging, causes, holds, cadences and recovery figures | NEC-12, AR-001, DUN-004, AGENT-003 | standard (+ sensitive) | `GET /api/nectar/ageing`, `/cadences`, `/recovery`; diagnosis partial |
| `nectar.collections.configure` | Activate a segment cadence and escalation schedule | AR-001 | live | `cadence.policy.prepare`, `cadence.policy.decide`, `cadence.enroll` |
| `nectar.promises.record` | Bind collection holds to an exact recorded promise to pay | AR-001 | commitment · live | `cadence.promise` |
| `nectar.disputes.record` | Record an exact invoice-line dispute and collection hold | AR-001, AR-003, AGENT-010 | commitment · live | `cadence.dispute`; processor dispute intake partial |
| `nectar.disputes.resolve` | Record dispute outcome and recompute currently permitted collection | AR-003, AGENT-010 | commitment · live | `cadence.resolve`; chargeback outcomes partial |
| `nectar.disputes.submit` | Submit a cited chargeback evidence pack to the processor | AR-003 | commitment · external (+ sensitive) (+ gated) | none |
| `nectar.tasks.create` | Create an internal follow-up or escalation task | NEC-12, AGENT-003 | standard | `task.create` |
| `nectar.tasks.complete` | Record a follow-up task's outcome | NEC-12 | standard | `task.complete` |
| `nectar.writeoffs.prepare` | Draft exact bad-debt value and accounting effect | AR-004 | standard | `writeoff.prepare` |
| `nectar.writeoffs.issue` | Record exact bad debt and its journal | AR-004 | money · commitment | `writeoff.issue`, `writeoff.approve` |
| `nectar.writeoffs.recover` | Allocate actual later recovery and reverse that part of bad debt | AR-004 | money | `writeoff.recover` |
| `nectar.tax.configure` | Record the exact declared tax basis and its business sign-off | NEC-01, TAX-001 | money · commitment · live | `tax.declare`, `tax.review` |
| `nectar.tax.calculate` | Request a line tax estimate with recorded source basis | TAX-001 | external (+ sensitive) (+ gated) | none; native declared-rate calculation only |
| `nectar.tax.commit` | Commit or reverse the exact issued tax transaction | TAX-001 | money · external (+ sensitive) (+ gated) | none |
| `nectar.certificates.collect` | Store an exemption document and its stated scope | TAX-002 | standard (+ sensitive) | `certificate.collect` |
| `nectar.certificates.validate` | Record the exact evidenced exemption determination | TAX-002 | commitment (+ sensitive) | `certificate.review`, `exemption.claim` |
| `nectar.tax.report` | Read jurisdiction totals, provider tie-out and nexus thresholds | TAX-003, TAX-004 | standard (+ sensitive) | none; native original-tax financial report only |
| `nectar.revenue.get` | Read line schedules, contribution sources and period roll-forward | REV-001, REV-002 | standard | `GET /api/nectar/revenue`, `/revenue-journal` |
| `nectar.close.prepare` | Assemble a packet of invoice, tax, payout and ledger breaks | AGENT-008 | standard (+ sensitive) | none |
| `nectar.close.record` | Close an exact revenue month and freeze its packet and journal | REV-002, AGENT-008 | commitment | `revenue.close`; full cross-system packet absent |
| `nectar.ledger.post` | Send a saved accounting journal and reconcile its ledger outcome | BOOK-001, BOOK-002, REV-002 | external (+ sensitive) (+ gated) | `ledger.post`; QuickBooks edge only, full connector grants/mappings absent |
| `nectar.reports.get` | Read metrics, financial reports and exact source drill-through | RPT-001, RPT-002, RPT-003, DUN-004 | standard (+ sensitive) | `GET /api/nectar/reports/{kind}`, report-source routes; normalized metrics partial |
| `nectar.exports.read` | Export role-visible rows, calculations or a frozen report snapshot | NEC-13, RPT-002, RPT-003 | standard (+ sensitive) | `/app/exports/*`, `/app/billing/{id}.json`, report-delivery CSV |
| `nectar.reports.schedule` | Set the sponsor's reversible internal report delivery schedule | RPT-002 | standard | `report.schedule` |
| `nectar.reports.send` | Deliver one frozen report snapshot to its resolved recipient | RPT-002 | standard or external (+ sensitive) | `src/nectar/report-mail.ts`; native scheduled delivery |
| `nectar.numbering.get` | Read the unified invoice/credit register and gaps | MOVE-011 | standard | `GET /api/nectar/number-register` |
| `nectar.numbering.configure` | Set an exact unused or continued invoice/credit number series | MOVE-011 | commitment | `invoice.series`; source capture remains separate |
| `nectar.imported.collect` | Collect an unchanged taken-over source invoice exactly once | MOVE-009 | money · external (+ gated) | `imported.collection.execute`; Stripe saved-card slice only |
| `nectar.imported.reconcile` | Read the original attempt and both billers' collection facts | MOVE-009 | external (+ gated) | `imported.collection.reconcile` |
| `nectar.imported.mirror` | Record the actual collected outcome in the source biller | MOVE-009 | commitment · external (+ gated) | `imported.collection.finalize` |
| `nectar.shadow.preview` | Compare the mapped app call and upcoming bill in shadow | DEV-006, AGENT-005 | standard (+ sensitive) | `app.invoice.preview`, `shadow.app.preview`, `GET /api/nectar/shadow` |
| `nectar.shadow.apply` | Apply an exact source-owned seat or service change through the mapped call | DEV-006 | money · commitment · external · live (+ gated) | `shadow.app.confirm`; quantity/period-end cancellation only |
| `nectar.migration.verify` | Tie first-cycle invoices and settled cash to each biller's ownership | AGENT-005 | standard (+ sensitive) | none; shadow comparison alone exists |
| `nectar.assurance.list` | Read evidenced cases, owners, fixes and scheduled scan outcomes | AGENT-001, AGENT-010 | standard (+ sensitive) | `GET /api/nectar/assurance-cases`, `/assurance-runs` |
| `nectar.assurance.scan` | Compare terms, usage, access, invoices and cash and open exact cases | AGENT-001, AGENT-010 | standard (+ sensitive) | `assurance.scan`; scheduled assurance observations exist |
| `nectar.assurance.assign` | Assign an existing authorized owner to a billing case | AGENT-001 | standard | `assurance.assign` |
| `nectar.assurance.confirm` | Sign off an exact current case basis without changing financial records | AGENT-001, AGENT-009 | commitment | `assurance.approve`; broader resolution absent |
| `nectar.assurance.recheck` | Re-evaluate exact source agreement and close or reopen the case | AGENT-001, AGENT-009, AGENT-010 | standard (+ sensitive) | `assurance.recheck` |
| `nectar.answers.get` | Answer from immutable billing figures with permitted source citations | AGENT-007, PORT-001, PORT-002 | standard (+ sensitive) | `answer.read`, portal answer routes |
| `nectar.answers.propose` | Turn an explicit suggested adjustment into a pending cited proposal | AGENT-007, NEC-14 | standard | `answer.propose`, `POST /portal/answer-proposal` |
| `nectar.members.list` | Read scoped members and roles | NEC-15, GOV-001 | standard | `GET /api/nectar/members`, `/roles` |
| `nectar.members.invite` | Invite a person with exact intended membership | NEC-15, GOV-001 | access (+ external) | `access.give` |
| `nectar.members.update` | Change another member's native role | NEC-15, GOV-001 | access | none; existing active members cannot be directly reassigned |
| `nectar.members.end` | End a member's access and sessions | NEC-15, GOV-001 | access | `access.end` |
| `nectar.roles.define` | Define a role's exact capability set | GOV-001 | access | `role.define` |
| `nectar.roles.update` | Change an existing role's exact capability set | GOV-001 | access | `role.update` |
| `nectar.credentials.issue` | Issue a scoped application or agent credential | NEC-14, GOV-006 | access · security | `credential.issue` |
| `nectar.credentials.revoke` | Revoke a credential and its continuing authority | NEC-14, GOV-006 | access · security | `credential.revoke` |
| `nectar.credentials.repin` | Change a credential's dated API version within its existing scope | DEV-002, GOV-006 | security | `credential.version` |
| `nectar.providers.connect` | Bind an existing merchant provider account and scoped credential | PAY-001, GOV-006 | access · security · external (+ gated) | none; runtime bindings and collection account references only |
| `nectar.providers.rotate` | Rotate the exact provider binding's credential | GOV-006 | security · external (+ gated) | none |
| `nectar.providers.disconnect` | Revoke a provider binding without losing historical facts | PAY-001, GOV-006 | access · security · external (+ gated) | none |
| `nectar.security.configure` | Change factor requirements and protective settings | GOV-007 | security | `mfa.policy` |
| `nectar.security.reset_factor` | Reset another member's factors and end sessions | GOV-007 | access · security | `mfa.reset` |
| `nectar.sso.configure` | Change identity-provider binding and exact provisioning mapping | GOV-003 | access · security · external (+ gated) | `sso.configure`; SAML/SCIM partial, OIDC absent |
| `nectar.portal.configure` | Set customer host, embedding origins and protection | PORT-005 | access · security | `portal.configure` |
| `nectar.portal.issue_session` | Issue exact customer and audience portal authority | PORT-005 | access · security | `portal.session.issue` |
| `nectar.portal.revoke_session` | Revoke a portal session | PORT-005 | access · security | `portal.session.revoke` |
| `nectar.webhooks.register` | Authorize an exact event endpoint and its secret | DEV-001 | access · security (+ external) | `webhook.register` |
| `nectar.webhooks.rotate` | Rotate one endpoint's signing secret | DEV-001 | security | `webhook.rotate` |
| `nectar.webhooks.disable` | End one endpoint's event authority | DEV-001 | access | `webhook.disable` |
| `nectar.webhooks.replay` | Resend one captured event to its current authorized endpoint | DEV-001 | standard or external (+ sensitive) | `webhook.replay` |
| `nectar.notifications.get` | Read the sponsor's reversible internal notification choices | INT-003 | standard | `GET /api/nectar/notifications` |
| `nectar.notifications.configure` | Change only the sponsor's internal event-email choices | INT-003 | standard | `notification.preferences` |
| `nectar.audit.list` | Read permitted typed audit facts and billing attribution | GOV-004 | standard (+ sensitive) | `GET /api/nectar/audit` |
| `nectar.erasures.request` | Record a scoped erasure request and draft its removal inventory | GOV-005, PORT-001 | standard (+ external) (+ sensitive) | `erasure.request`, `POST /portal/privacy` |
| `nectar.erasures.verify` | Record evidenced alternate verification of one exact request | GOV-005 | commitment (+ sensitive) | `erasure.verify`; mailbox confirmation stays interactive |
| `nectar.erasures.execute` | Remove verified personal data with the exact retained exceptions | GOV-005 | destructive (+ sensitive) | `erasure.approve` |
| `nectar.erasures.purge` | Remove retained financial facts only at their due boundary | GOV-005 | destructive (+ sensitive) | `erasure.purge` |
| `nectar.events.list` | Read typed change events with a continuation cursor | DEV-001, GOV-004, AGENT-010 | standard (+ sensitive) | none; native audit and signed webhooks exist separately |

**Resources.** `nectar://business/{id}`, `nectar://entity/{id}`, `nectar://customer/{id}`, `nectar://contact/{id}`, `nectar://product/{id}`, `nectar://price/{id}`, `nectar://meter/{id}`, `nectar://subscription/{id}`, `nectar://usage_event/{id}`, `nectar://usage_batch/{id}`, `nectar://control_total/{id}`, `nectar://billrun/{id}`, `nectar://invoice/{id}`, `nectar://invoice_line/{id}`, `nectar://credit/{id}`, `nectar://payment/{id}`, `nectar://collection_attempt/{id}`, `nectar://refund/{id}`, `nectar://dispute/{id}`, `nectar://balance/{id}`, `nectar://prepaid_grant/{id}`, `nectar://prepaid_entry/{id}`, `nectar://dunning_sequence/{id}`, `nectar://reminder/{id}`, `nectar://task/{id}`, `nectar://proposal/{id}`, `nectar://order_source/{id}`, `nectar://case/{id}`, `nectar://certificate/{id}`, `nectar://revenue_schedule/{id}`, `nectar://period_close/{id}`, `nectar://ledger_posting/{id}`, `nectar://report_snapshot/{id}`, `nectar://payment_link/{id}`, `nectar://member/{id}`, `nectar://role/{id}`, `nectar://credential/{id}`, `nectar://provider_connection/{id}`, `nectar://webhook_endpoint/{id}`, `nectar://webhook_delivery/{id}`, `nectar://erasure/{id}`, `nectar://audit_event/{id}`, `nectar://migration/{id}`, `nectar://coupon/{id}`, `nectar://promotion/{id}`, `nectar://renewal_term/{id}`, `nectar://retention_offer/{id}`, `nectar://feature_policy/{id}`, `nectar://topup_authorization/{id}`, `nectar://retry_policy/{id}`, `nectar://cadence/{id}`, `nectar://invoice_series/{id}`, `nectar://receipt/{id}`, `nectar://report_definition/{id}`, `nectar://notification_preference/{id}`, `nectar://provider_step/{id}`. Native record-family visibility determines each projection, including own-customer portal fields. Credential resources contain references and scope, not secret bytes. Customer, external, imported, document, metadata and log text carry the untrusted marker. Exact import originals remain opaque attachments under their native custody.

**Events.** `customer.created`, `customer.updated`, `subscription.created`, `subscription.changed`, `subscription.state_changed`, `usage.accepted`, `usage.threshold_crossed`, `usage.control_mismatch`, `invoice.prepared`, `invoice.issued`, `invoice.paid`, `invoice.payment_failed`, `payment.recorded`, `payment.settled`, `payment.returned`, `credit.issued`, `refund.changed`, `dispute.changed`, `entitlement.changed`, `proposal.created`, `proposal.decided`, `assurance.case_changed`, `assurance.run_changed`, `collection.hold_changed`, `message.outcome`, `provider.step_required`, `ledger.posting_changed`, `revenue.period_closed`, `migration.changed`, `access.changed`, `erasure.completed`. These are the target typed feed; today's webhook subset and audit are not claimed to implement the entire list.

**Prompts.** The billing controller offers: prepare the billing week (NEC-05, NEC-06, NEC-07, NEC-09, NEC-10, USE-007); translate an executed order (AGENT-006, CAT-003, INV-004); investigate and correct a mismatch (AGENT-001, AGENT-002, AGENT-009, AGENT-010); resolve an unpaid account's cause (AGENT-003, AR-001, DUN-001, DUN-004); compare a price cohort (AGENT-004, CAT-007); verify the first settled migration cycle (AGENT-005, MOVE-009); answer a cited billing question (AGENT-007); tie out and close the month (AGENT-008, REV-001, REV-002).

**Not tools, and why.**

- *The import door:* NEC-16, MOVE-001, MOVE-002, MOVE-003, MOVE-004, MOVE-005, MOVE-006, MOVE-007, MOVE-008, MOVE-010. Captures, live source sync, token migration, historical custody, shadow adoption, source-owned usage relay and installation restores are import tasks, not a parallel set of agent import executors. The tools above inspect shadow comparisons and verify the subsequent settled cycle; collecting a taken-over open original is an ordinary billing job.
- *A connector:* USE-003 (storage/warehouse ingestion), RPT-004 (warehouse/BI destinations), CRM-001 (closed-won deal exchange), CRM-002 (executed-document intake), INT-001 (chat event delivery), INT-002 (workflow/support context), AR-005 (AP-portal exchange). Their transport and account consent belong to the connected app; Nectar's native records and resulting billing actions use this surface.
- *An operation or installation fact:* DEV-003 (SDK packaging and embeddable client components), DEV-004 (isolated sandbox installation and clock infrastructure), OPS-001 (measured capacity and restart behavior). These are properties of the installation or its clients rather than specialist business calls.
- *A person's interactive screen:* MOB-001 (operator screen layout), MOB-003 (customer screen and email layout), GOV-002 (people author the company's policy and its separation rules). Own sign-in, password and factor entry, customer consent and processor-hosted card/3-D Secure screens also stay interactive; requesting or following their native outcome is a typed job above.
- *Device-only:* MOB-002 (native mobile shell, push delivery and device interaction); the underlying billing reads and actions use the tools above.

**Limits.** Existing native bounds are 5,000 usage events per request, 1–100 rows per API page, a 200-subscription price cohort, a 256,000-byte optional executed-order original, and exploratory historical replay of 1–36 issued periods with at most 10,000 void ids and 10,000 addition ids; full-chain financial correction preparation has no 36-period truncation. Larger ingestion and measured throughput remain the capacity work of the installation. These capacity bounds are distinct from business limits and spend caps, which are the company's policy. No spend-cap enforcement is promised by this draft.

**Handoffs.** Listen for closed-won deal and executed-order arrivals from CRM/contract connectors, processor payment/refund/dispute outcomes, source-biller import progress, and identity-provider membership changes. Their external type names are connector-owned, not new sibling contracts. Emit typed invoice, payment, entitlement, proposal, case, message, ledger and close events above to the merchant product, CRM, ledger, support and workflow connectors. A source import reports `migration.changed`; the controller compares the first native invoice and settled payment and reports their original references. A tax commitment failure or ledger mismatch becomes an evidenced case and close-packet break, not an invented successful post.

#### SURFACE-001 — The registry is Nectar's Agent surface
*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-002, BASE-AGENT-006, BASE-AGENT-013

**Requirement.** Nectar's registry contains exactly this area's typed billing jobs, resource templates, event types and specialist prompts, including honest native-backing gaps. The registry is the buildable specification for the seed's delta on the Base door.

**Acceptance.**
1. Discovery lists exactly the tool names and resource templates above, with each tool's Core ids and complete class alternatives matching its row.
2. Core ids from the contract's Core set are all accounted for by tool rows or one stated non-tool reason, with no overlap or unknown id.
3. A read and its paired mutation have different tool names; every name has exactly the three lowercase segments shown above.
4. Native fixtures for customer edits, metric activation, invoice issue, payment allocation and correction execution yield the same business records through the tool and browser action.
5. A registry backing marked none reports an unavailable capability until implemented, rather than claiming an existing native or MCP action.
6. The Base harness passes on Nectar's fixtures under the named All-autonomous company policy and the named Held company policy in SURFACE-012.

#### SURFACE-002 — Billing evidence has exact content and sources
*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-003, BASE-AGENT-005, BASE-AGENT-006

**Requirement.** Nectar exposes its exact calculation operands, original sources, financial definitions and customer projections through the read jobs and resources, with sensitivity determined from the actual permitted projection.

**Acceptance.**
1. An invoice resource returns saved line cents, tax basis, quantity, rounding version and input fingerprint, and a cited answer's numeric operands resolve to those exact source paths.
2. On one entity fixture, a masked EIN projection declares standard only; an authorized projection returning its full EIN declares standard plus sensitive, one record, kind ID.
3. A safe card summary containing brand and last four declares standard only; a permitted funding-instruction document returning the full virtual bank number declares standard plus sensitive, with bank kind and record count.
4. Operator, accountant, support and own-customer reads match the native record-family projections, including typed prepaid refund facts without private refund narrative or raw processor proof.
5. Changing a source file's words to say internal or confirmed changes neither sensitivity nor any destination facts; source, note and log text remain marked untrusted.
6. A bill-run export retains its original calculation evidence, while erased source payloads stay withdrawn and retained minimal financial facts retain their original dates and cents.

#### SURFACE-003 — Commercial terms use exact native billing effects
*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-002, BASE-AGENT-006, BASE-AGENT-008, BASE-AGENT-012

**Requirement.** Nectar's order, catalog, cohort and subscription tools expose separate preparation and execution of real commercial jobs. Their amounts come from Nectar's exact engine and their commitment facts identify the quoted source and affected counterparties.

**Acceptance.**
1. Preparing a three-year ramp order with a minimum and uplift produces quoted terms, every finite service period and exact totals without changing catalog, subscriptions or money.
2. Applying that same current basis declares money, commitment and live with the exact customer, currency, dated charges and service, and ordinary billing matches its preview.
3. Publishing a new price, coupon or promotion declares money even before its first sale; a six-period price simulation declares standard and changes no charge.
4. A scheduled cohort migration keeps grandfathered subscriptions unchanged and installs only its frozen customers, effective dates and exact price versions.
5. Pause, resume, cancellation, reactivation and trial extension declare their money, commitment and live classes and reproduce the native service bounds, unused-service credits and entitlements.
6. A later source, quantity, date or price change invalidates the saved basis; retrying one successful apply returns the same result without another subscription or charge.
7. Agent-applied terms are attributed to the agent for its sponsor, without inventing a person's signature or acceptance of a customer offer.

#### SURFACE-004 — Metered work preserves event and correction custody
*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-002, BASE-AGENT-006, BASE-AGENT-009, BASE-AGENT-012

**Requirement.** Nectar's usage and metric tools preserve stable event identity, immutable issued evidence and exact historical deltas, including grouped and time-weighted metrics, prepaid wallets and signed commitments.

**Acceptance.**
1. Submitting the same event twice records one event; a reused id with different quantity is refused and records no replacement.
2. Metric preview declares standard and preserves exact rational quantities; activation declares live and names its metric service and version without rewriting bound prices.
3. Daily control discrepancies name day, meter, count and exact quantity; recording an exact discrepancy decision declares commitment with its current source basis.
4. On the same historical correction, preview and preparation declare standard without financial writes; apply declares money and commitment and appends only the exact cumulative delta.
5. A completed prepaid cash refund's quantity and cents stay fixed through repeated corrections; any restored value is a separate retained-credit ledger contribution.
6. Upcoming and customer usage views refresh from the same recorded events and ledger, consume nothing, and reproduce the eventual invoice under unchanged inputs.

#### SURFACE-005 — Issued invoices and balances remain reconcilable
*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-002, BASE-AGENT-006, BASE-AGENT-008, BASE-AGENT-012

**Requirement.** Nectar's invoice, credit, payment-evidence, balance and bad-debt jobs retain their exact financial basis, numbering and append-only originals through the agent door.

**Acceptance.**
1. A draft run declares standard; issuing its unchanged invoice declares money and commitment with exact currency, total and customer, claims the period once and continues the selected number series.
2. A credit, cash allocation, goodwill grant, balance application, write-off or recovery declares money with its actual amount and counterparty; invoice total, credits, paid, written-off and owed reconcile exactly.
3. Voiding an unpaid invoice declares money and destructive, names one item, leaves its original lines unchanged and creates one linked void; retry creates no second void.
4. An uncertain capture or pending settlement prevents an unsupported void through the same native financial invariant as the browser, independently of the company-policy decision.
5. A correction's actual before/after tax, revenue and carried-credit effect agrees with source drill-through, customer projection, CSV and frozen report snapshot without claiming an unsupported tax reversal.
6. Recording external cash remains labelled recorded evidence, while a provider-confirmed settlement retains the actual processor reference and outcome.

#### SURFACE-006 — Processor and provider steps retain their real outcomes
*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-002, BASE-AGENT-006, BASE-AGENT-008, BASE-AGENT-012

**Requirement.** Nectar's collection, refund, cash, method and provider jobs bind every provider request to the merchant account, customer, currency, exact basis and original attempt identity. A provider-held interactive step is represented honestly rather than fabricated as completed.

**Acceptance.**
1. Collection, prepaid purchase, top-up, refund and cash return declare money and external with the exact amount, currency, merchant route and known customer or sender.
2. On the same collection fixture, a processor result requiring no interaction carries money and external only; its authentication-required variant adds gated, provider and hosted 3-D Secure step, retaining the original attempt identity.
3. On one existing-account connection fixture, a complete restricted credential carries access, security and external; a provider response requiring account consent adds gated and names the provider's consent screen.
4. Timeout reconciliation reads the original provider reference without creating another charge, setup, refund or funding claim; capture dates are the actual provider dates.
5. Method setup and default selection remain distinct recorded outcomes; safe references and customer choice are not re-labelled debit authority, and a missing provider result remains unresolved.
6. A third-party hosted checkout retains card entry with a person at the provider; the surface exposes its step and outcome without a password, factor or CAPTCHA-solving tool.
7. The provider, SSO and credential families refuse any request widening the sponsor's or agent's own authority under every company policy, including the All-autonomous policy.

#### SURFACE-007 — Outbound billing carries its exact exposure
*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-003, BASE-AGENT-006, BASE-AGENT-008, BASE-AGENT-009

**Requirement.** Nectar computes exposure from the resolved recipient, endpoint and content for notices, invoices, notes, correction messages, webhooks and public checkout links. Financial preparation and message delivery remain separately visible outcomes.

**Acceptance.**
1. Sending the same seeded invoice document to an internal colleague declares standard; sending it to its on-record customer declares external, known counterparty and one recipient, without changing the document's cents.
2. Replacing that recipient with an unrecorded outside address declares external and new; publishing its payment link declares external and public with its actual audience, alongside money, commitment and live.
3. On that document fixture, excluding a full bank number adds no sensitive class; including its permitted funding instructions adds sensitive, one record and bank kind, for either destination.
4. One endpoint registration fixture declares access and security with direction widens for an internal destination; changing only to an outside endpoint adds external with its resolved counterparty and recipient facts.
5. A note's resolved outside mention adds external to destructive; an internal mention does not. The immutable note still records its real author and content sensitivity.
6. Sending honors the exact frozen wording, customer language, recipient, current collectible balance, disputes and promises; an authored explanation stays authored rather than silently translated.
7. Provider accepted, refused, suppressed and uncertain remain distinct outcomes; an uncertain send or replay never claims another delivery without actual evidence.

#### SURFACE-008 — Tax, revenue and close use sourced financial facts
*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-002, BASE-AGENT-006, BASE-AGENT-008, BASE-AGENT-012

**Requirement.** The controller reads and ties Nectar's tax transactions, revenue schedules, report operands and ledger outcomes without treating an estimate or an unconfirmed connector post as settled money or completed accounting.

**Acceptance.**
1. A tax calculation declares external and its actual content classes without claiming money moved; committing the issued transaction declares money and external with exact jurisdiction amounts.
2. Provider responses requiring tax or ledger account consent add gated with the actual provider and step; the same fixture with complete authorization adds no gated class.
3. Revenue line schedules and month roll-forward conserve exact pretax cents, and their report drill-through resolves to the immutable invoice and correction contributions.
4. A close declares commitment and names its exact period, packet and sign-off basis; a later correction posts in the open period without changing the closed CSV or journal.
5. Posting the saved journal declares external, with sensitive added only for actual protected fields; a provider failure remains a named close-packet break with its actual retry state.
6. A prepared pricing comparison's assumed provider cost and expected margin remain labelled estimates, carry standard on the internal read, and cause no money call.

#### SURFACE-009 — Administrative jobs carry authority and protection facts
*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-005, BASE-AGENT-006, BASE-AGENT-008

**Requirement.** Nectar classifies membership, role, grant, provider and protection changes from their native target and direction, using the sponsor's current capabilities and truthful administration history.

**Acceptance.**
1. Membership and role changes declare access with affected people and widens or narrows; credential issue/revoke, factor reset, provider connect/disconnect, SSO and portal authority also declare their listed security class and setting.
2. On one invitation fixture, an internal member invitation declares access only; changing its destination to an outside contractor adds external, new counterparty and one recipient.
3. Members, roles and credentials tools refuse making the sponsor more privileged, widening the calling agent's grant or arranging the same widening through another role, under every company policy.
4. Provider binding, SSO/provisioning and security-setting/factor-reset tools refuse widening the sponsor's or agent's own authority under every company policy; a factor reset cannot be used to take over another identity.
5. Portal configuration, session issue/revoke and webhook registration/rotation/disable tools likewise refuse self-widening under every company policy; changing an origin or endpoint cannot evade the target's current authority comparison.
6. Repinning a credential and rotating a webhook or provider secret declare security with their exact setting, expose no secret in resources or audit, and cannot change scope as a side effect.
7. Narrowing another member's membership or revoking a session records access, narrows, and the next billing read observes the native revocation.

#### SURFACE-010 — Irreversible billing records and privacy have explicit scope
*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-003, BASE-AGENT-006, BASE-AGENT-009, BASE-AGENT-012

**Requirement.** Nectar exposes exact inventories and receipts for irreversible notes, voids and privacy removal, retaining only the native financial exceptions and their real expiry rather than recreating erased source data.

**Acceptance.**
1. On one erasure fixture, recording the request declares standard without removing data; sending its on-file verification adds external, known counterparty and one recipient. Executing the verified inventory declares destructive with item count.
2. On one customer fixture, erasure of ordinary contact fields adds no sensitive class; adding a stored tax-ID certificate makes the same inventory include sensitive, one protected record and ID kind.
3. The erasure receipt enumerates removed fields, import-custody withdrawal, retained minimal legal facts and exact business-local expiry; an early financial purge is refused by the native retention invariant.
4. Due removal declares destructive with the real financial item count, runs once and leaves its removal receipt without reviving customer sessions or old imported bytes.
5. Publishing an append-only note declares destructive; a later correction is another attributed note and does not pretend to erase or edit its original.
6. Customer, export, report and event projections after erasure contain no withdrawn narrative or protected source payload; minimal retained cash and liability facts remain numerically unchanged.

#### SURFACE-011 — The controller follows causes through events and handoffs
*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-002, BASE-AGENT-003, BASE-AGENT-006, BASE-AGENT-010

**Requirement.** Nectar's specialist prompts connect its real billing jobs: source discrepancy, billing case, corrective delta, customer contact, actual collection and close tie-out. Events link each step to the native records that prove its outcome.

**Acceptance.**
1. A planted unbilled ramp, excessive seat, missing minimum, unapplied credit and stale feature produce separate deduplicated cases naming their exact source and authorized owner.
2. Recording exact case agreement declares commitment; rechecking closes only when current source facts agree, and a later regression reopens the case without changing immutable financial records.
3. A bounced invoice, missing PO and expired card are distinguished by their real evidence; the resulting tasks, exact notices and collection outcomes stay linked, while dispute and promise facts preserve the native collection holds.
4. The events tool resumes at the same native event ids as the webhook feed, preserves its typed invoice/payment/case relationships, and returns only content in the sponsor's current record scope.
5. The migration prompt compares the adopted subscription's first issued invoice and actually settled cash with both billers' ownership records, and names a missing settlement instead of reporting success from a shadow estimate.
6. A close packet retains a missing fee, unsynced credit and failed tax commitment until their exact corrective records and provider outcomes reconcile.

#### SURFACE-012 — The billing controller completes a week under two policies
*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-007, BASE-AGENT-008, BASE-AGENT-009, BASE-AGENT-013

**Requirement.** A stranger agent discovers Nectar and runs a seeded week through MCP under two named company policies set by people beforehand. All-autonomous is autonomous for every fleet class. Held sets standard to review and every other class to approval. Neither is a product preset.

**Acceptance.**
1. Given only Nectar's URL and a named sponsor, the stranger discovers tools, resources, prompts and capacities without private installation knowledge.
2. The week seeds a signed ramp order, duplicate/late usage, billing, over-billing, prepaid drawdown, failed collection, a promise, migration settlement and month-end breaks; existing customer mandates and complete provider connections are fixture facts.
3. Under All-autonomous, the week completes with no person: exact terms installed, invoices issued once, money collected/corrected, explanations sent, cases rechecked and the reconciled period closed.
4. Under Held, standard calls enter review; money, commitment, external and live steps wait for approval without side effects and execute once the test person grants their decisions.
5. In Held, withholding the correction/message approvals changes no financial/outbound records; granting both produces one adjustment and message outcome, attributing the person's decisions separately from agent preparation.
6. Both runs reconcile invoice, cash, credit, prepaid, revenue and report cents independently and record zero decisions differing from the active policy revision.
7. Both policies refuse self-widening; a provider-held step reports gated with its real provider and step, never invented completion.

## Status rows

| Clause | Title | Kind | Status | Evidence | Gap |
| --- | --- | --- | --- | --- | --- |
| `SURFACE-001` | The registry is Nectar's Agent surface | target | missing | | Nectar has no matching MCP registry or passing Base harness on its fixtures under both policies yet. |
| `SURFACE-002` | Billing evidence has exact content and sources | target | missing | | The resource projections and per-content sensitivity facts are not exposed through MCP yet. |
| `SURFACE-003` | Commercial terms use exact native billing effects | target | missing | | Commercial tools do not yet execute through a class-aware agent door. |
| `SURFACE-004` | Metered work preserves event and correction custody | target | missing | | Meter and correction jobs lack MCP parity and declared per-call facts. |
| `SURFACE-005` | Issued invoices and balances remain reconcilable | target | missing | | The agent door does not yet expose policy-decided native issue, credit, allocation and void jobs. |
| `SURFACE-006` | Processor and provider steps retain their real outcomes | target | missing | | Provider jobs lack MCP classification and typed gated-step outcomes. |
| `SURFACE-007` | Outbound billing carries its exact exposure | target | missing | | Destination and content classes are not yet computed for outbound MCP calls. |
| `SURFACE-008` | Tax, revenue and close use sourced financial facts | target | missing | | Tax, revenue, ledger and close jobs have no complete classified MCP surface. |
| `SURFACE-009` | Administrative jobs carry authority and protection facts | target | missing | | Native administrative families lack the classified agent door and complete self-widening refusal proof. |
| `SURFACE-010` | Irreversible billing records and privacy have explicit scope | target | missing | | MCP removal inventories and destructive/content-class receipts are not implemented. |
| `SURFACE-011` | The controller follows causes through events and handoffs | target | missing | | The controller prompts and typed replayable cross-job feed are not implemented. |
| `SURFACE-012` | The billing controller completes a week under two policies | target | missing | | A stranger agent has not completed the seeded billing week through MCP under both company policies. |
