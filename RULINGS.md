# Nectar ct rulings

### RL-101 — Explicit hierarchy billing authority and credit conservation

Date: 2026-10-28 · Ruler: ct · Governs: CAT-009

Question: May the owner link a one-level same-entity hierarchy without implicitly sharing payments, portal access or credits?

Default adopted/proposed: Owner-only audited link; no automatic charge or parent/child portal disclosure; pooled commitment tracks spending only; all credit sharing held after a demonstrated conservation failure.

Outcome: **adopt with rider** — Approve the proposed default subject to the precise conditions below.

Normative outcome: Approve explicit same-entity linking with separate invoice-owner, payer and disclosure choices; linking alone grants neither portal access nor debit authority. Shared funding, minimum settlement and credits remain refused until an atomic conserved transfer preserves donor debit and child receipt through independent expiry/erasure/restore, never recreates spent value and retains original source ownership.

Why and incumbent comparison: Chargebee explicitly separates invoice/payment responsibility and visibility; Stripe’s customer model binds payment configuration to the customer. No common norm for Nectar’s one-level limit or credit-sharing custody is established by those implementations. The safe default is explicit financial authority and conservation, while the contracted shared commitment/credit capability remains unfinished rather than removed.

Placement (one copy): Place hierarchy authority/conservation once in CAT-009; cite GOV-001/GOV-005 and payment authority rather than duplicating them.

Engineering/proof: The 150000-cent recreation is an engineering defect, not an owner policy choice. Shared commitments, source-specific consolidation and mixed period/entity completeness remain open. Main names only generic subscription billers; Stripe is the concrete source API and Chargebee the explicit hierarchy comparator, not an invented first-named incumbent.

Sources:
- [https://docs.stripe.com/billing/customer](https://docs.stripe.com/billing/customer) — Stripe keeps billing profiles, payment methods and invoice configuration associated with the customer.
- [https://www.chargebee.com/docs/billing/2.0/customers/account-hierarchy](https://www.chargebee.com/docs/billing/2.0/customers/account-hierarchy) — Chargebee explicitly sets invoice/payment owners and portal responsibilities for linked accounts; credits follow invoice ownership and refunds the original method.

Observed clauses and complete Status Gaps:

- CAT-009: CONTRACT.md:152; Status at line 608. Gap: Default ADOPTED pending ct: owner-only audited authorization to link one level within one entity; no automatic card charge or parent/child portal disclosure. Pooled commitment is spending tracking only, with no shared minimum settlement or funding. All credit sharing is unavailable: the withdrawn branch experiment recreated 150000 cents of spent parent goodwill after child financial expiry; independent donor-debit and child-receipt retention custody is required. Full shared commitment execution, individual contract/prepaid/correction-source consolidation and broader mixed-period/entity parity remain unproved; unsupported sources are refused.

### RL-102 — Consented metadata webhook disclosure

Date: 2026-10-28 · Ruler: ct · Governs: DEV-001

Question: May owner/developer endpoint management and replay send exact authorized metadata without built-in contact narratives or restored outbox authority?

Default adopted/proposed: GOV-001 owner/developer endpoint/secret consent and replay; finance typed failure monitoring; no historical sends; no built-in contact/narrative fields; exact authorized metadata; outbox excluded from archives.

Outcome: **adopt with rider** — Approve the proposed default subject to the precise conditions below.

Normative outcome: Approve the default: endpoint creation/rotation/replay checks current exact scope and recipient consent under GOV-001, metadata snapshots preserve the event-time authorized maps without adding hidden narrative/contact fields, and finance failure notices disclose only the exact authorized item. Import/restore never auto-sends history; an explicitly reviewed replay of a retained approved event preserves identity, lineage and duplicate-safe receiving behavior.

Why and incumbent comparison: Stripe documents configured event endpoints, signing, duplicate handling, replay and rotation. No common norm establishes Nectar’s metadata allowlist or archive-outbox exclusion; these limit incidental disclosure and prevent restored executable authority. Arbitrary metadata remains potentially sensitive and endpoint approval must cover its actual fields, not treat metadata as inherently anonymous.

Placement (one copy): State the webhook-specific disclosure/custody point once in DEV-001; cite GOV-001 authority and DEV-005 snapshot ownership.

Engineering/proof: Live mapping, complete event kinds and scale remain subject to existing evidence. Main uses generic subscription-biller naming; Stripe is the concrete API source used for the comparison.

Sources:
- [https://docs.stripe.com/webhooks](https://docs.stripe.com/webhooks) — Stripe documents signed endpoint events, configured event types, duplicate handling, replay and signing-secret rotation.

Observed clauses and complete Status Gaps:

- DEV-001: CONTRACT.md:198; Status at line 628. Gap: Default ADOPTED pending ct: owner/developer consented endpoint/secret management and replay under GOV-001, finance typed failure monitoring, no historical sends, no built-in narrative/contact fields; explicitly authorized metadata remains exact, operational outbox excluded from archives. `tests/nectar/webhooks.mjs` — webhookLifecycleFlow additionally proves complete imported creation snapshots after provenance, duplicate-free import reapplication, all published authenticated test-shadow event mappings, concurrent receipt deduplication, role/source/consent refusal and typed provider custody delivered once through HMAC. `tests/nectar/webhook-shadow-sandbox.mjs` additionally proves actual held-key test-account events, authenticated source capture, exact local metadata and once-only HMAC reception with owned-clock cleanup. Unproved: policy approval; webhookLifecycleFlow also proves credit-only, goodwill and fully carried-credit settlement exactly once with zero cash allocation, and no paid claim for a write-off. Independent USE-005 spend thresholds remain that clause’s obligation. Native webhook screens used at 1440/390; live mapping proof and policy approval keep the clause partial.

### RL-103 — Exact test-only source writes before cutover

Date: 2026-10-28 · Ruler: ct · Governs: DEV-006

Question: May a fresh-factor owner explicitly confirm prepared no-proration source writes in test mode while the source still bills the shadow customer?

Default adopted/proposed: Owner-session/fresh factor; prepare and confirm exact test-only seat quantity or period-end cancellation; no proration; source read-only reconciliation for uncertain writes; cutover fence.

Outcome: **adopt with rider** — Approve the proposed default subject to the precise conditions below.

Normative outcome: Approve those exact test-mode source writes: preparation binds customer/subscription, source account/mode, operation and before/after values; confirmation rechecks live authority and shadow/cutover state, submits once with stable identity and reconciles unknown outcomes by reads. This grants no automatic customer creation, live write, immediate cancellation, price change or production cutover.

Why and incumbent comparison: Stripe distinguishes isolated billing test objects from live activity and documents the complete subscription test flow. No common norm establishes Nectar’s fresh-factor/two-stage shadow-write harness; strict exact-action preparation is the safest default at a biller transition boundary. A separate actual cutover remains owner-reserved, but the present test-mode product default is ct’s decision.

Placement (one copy): Put this current shadow-write delta once in DEV-006 and cite native GOV controls and MOVE-006 synchronization/cutover fences.

Engineering/proof: The broad call map remains binding: checkout/customer/subscription creation, price/immediate-cancel/portal writes, meter relay, payment methods and entitlement parity are still unbuilt/unproved, not waived.

Sources:
- [https://docs.stripe.com/billing/testing](https://docs.stripe.com/billing/testing) — Stripe separates sandboxes from live activity and describes billing test-clock simulations and real test-object webhook qualification.

Observed clauses and complete Status Gaps:

- DEV-006: CONTRACT.md:206; Status at line 632. Gap: Published call map distinguishes every required call and parameter boundary. Unproved: complete live call-by-call switch-over, checkout and source customer and subscription creation, source customer/price/immediate-cancel and portal writes, Stripe-format meter relay, compatible payment-method list and entitlement sync. Adopted conservative owner-session, fresh-factor, prepared and confirmed test-only no-proration writes await ct; current native governance remains.

### RL-104 — Reviewed dunning messages and original-intent recovery

Date: 2026-10-28 · Ruler: ct · Governs: DUN-002

Question: May the current owner enroll and separately confirm each exact dunning send and terminal action without unattended execution?

Default adopted/proposed: Fresh-factor owner enrollment; each message prepared and confirmed; existing hosted setup links expire within fifteen minutes/original factor; separate customer consent and human approval of original-intent recovery within caps; exact terminal confirmation.

Outcome: **adopt with rider** — Approve the proposed default subject to the precise conditions below.

Normative outcome: Approve that current-door default: source/recipient/collectible balance/consent/dispute/promise/expiry are rechecked before the once-only message claim; uncertain sends never resend; setup authority neither extends itself nor grants debit consent; recovery retains the original payment intent and caps, and terminal restriction/cancellation uses existing subscription governance. Restored dunning records carry no executable authority.

Why and incumbent comparison: Stripe offers merchant-configured automatic recovery and dunning, so per-message owner confirmation is not the incumbent automation norm. No common norm establishes this exact interim custody. Choose it as a safe current implementation, while preserving the original policy-enabled unattended sequence and broader governed-role target in full.

Placement (one copy): State dunning-specific custody once in DUN-002; cite existing GOV-001 and payment/retry authority rather than restating them in every sequence.

Engineering/proof: Optional webhooks, full archive/restore proof and autonomous sequence implementation remain owed. Provider acceptance is not mailbox delivery. This ruling resolves the policy hold without converting the manual slice into full completion.

Sources:
- [https://docs.stripe.com/billing/revenue-recovery](https://docs.stripe.com/billing/revenue-recovery) — Stripe offers configured automatic recovery emails, retries and dunning workflows.

Observed clauses and complete Status Gaps:

- DUN-002: CONTRACT.md:292; Status at line 650. Gap: Pending ct approval of the adopted conservative default: explicit fresh-factor owner enrollment, per-message preparation and send confirmation, short-lived existing hosted setup links, separately consented and human-approved original-intent recovery within original caps, and explicit terminal confirmation with cancellation through existing governance. No unattended sequence or terminal action is enabled; optional step webhooks and full archive and restore proof remain unbuilt. The original full clause and GOV-001 broader role duties remain required; this owner-only operational custody is interim, while existing customer and invoice and payment and report reads retain their capabilities. Provider acceptance does not claim mailbox delivery.

### RL-105 — Approved invoice-automation policy without implicit collection

Date: 2026-10-28 · Ruler: ct · Governs: INV-001

Question: May an independently confirmed invoice policy issue exception-free drafts once per local day without granting email or debit authority?

Default adopted/proposed: Owner prepares; different owner or finance approver confirms, with explicit sole-owner second confirmation only if no other active approver exists; one daily attempt; no exception auto-acknowledgment, invoice email or charge consent.

Outcome: **adopt with rider** — Approve the proposed default subject to the precise conditions below.

Normative outcome: Approve those enablement defaults: the approved exact business-local policy permits the scheduler to issue clean invoices within its bounds, rechecking current approver authority and financial sources; exceptions remain in human review, interrupted attempts remain visible without automatic recovery, and email/collection need their separate approved policies.

Why and incumbent comparison: Stripe exposes independent automatic-advancement/collection configuration. No common norm requires Nectar’s two-person enablement or once-per-day attempt policy; these are conservative choices separating permission to issue from permission to communicate or move money. The sole-owner escape requires the stated explicit second confirmation and cannot bypass an available independent approver.

Placement (one copy): Place schedule-enable authority once in INV-001 with citations to GOV-002, INV-002 and PAY-003.

Engineering/proof: Full scheduled delivery/collection, threshold/one-time automation, broader catch-up and interrupted recovery remain engineering/proof obligations; an unavailable provider sandbox does not hold this policy decision.

Sources:
- [https://docs.stripe.com/invoicing/integration/automatic-advancement-collection](https://docs.stripe.com/invoicing/integration/automatic-advancement-collection) — Stripe exposes explicit automatic-advancement configuration, separately controlling finalization, charging and notices.

Observed clauses and complete Status Gaps:

- INV-001: CONTRACT.md:212; Status at line 634. Gap: Automatic invoice email and processor collection remain unbuilt; INV-002 requires the unavailable Postmark sandbox. Threshold and standalone one-time automation, catch-up beyond the previous and current months, and interrupted-attempt recovery remain unproved. Adopted default pending ct: owner prepares, a different owner or finance approver confirms (sole-owner explicit second confirmation only without another active approver), each business day is attempted once, no exception is auto-acknowledged, and this consent authorizes neither invoice email nor processor charges.

### RL-106 — Customer detail hiding closes alternate evidence doors

Date: 2026-10-28 · Ruler: ct · Governs: INV-004

Question: May an invoice with hidden usage detail also refuse customer calculation-evidence doors while preserving complete operator evidence?

Default adopted/proposed: Customer invoice answer/evidence refuses when usage detail is hidden; operator calculation and export evidence remains complete.

Outcome: **adopt with rider** — Approve the proposed default subject to the precise conditions below.

Normative outcome: Approve the visibility rule: every customer representation of that invoice, including answer/evidence APIs, follows its frozen hidden-detail setting, returns the same summary totals and never leaks the hidden per-event/tier breakdown; authorized operators keep full calculations and exports under their existing permissions.

Why and incumbent comparison: Stripe summary items hide underlying line items from customer rendering. Its operator API retains underlying detail. No common norm is established for Nectar’s distinct invoice-answer endpoint; treating it as another customer presentation prevents bypass of an explicitly selected invoice view without denying the invoice itself.

Placement (one copy): State the customer-view invariant once in INV-004 and cite it from the customer answer door; retain NEC-13 operator evidence.

Engineering/proof: Email presentation, provider remit instructions and unsupported-character PDF behavior remain honest gaps; this ruling authorizes no substitution of unreadable characters.

Sources:
- [https://docs.stripe.com/invoicing/line-item-grouping](https://docs.stripe.com/invoicing/line-item-grouping) — Stripe summary items can hide underlying invoice detail from customer rendering while retaining underlying invoice items.

Observed clauses and complete Status Gaps:

- INV-004: CONTRACT.md:220; Status at line 637. Gap: Email presentation remains unproved under INV-002. PDF text currently supports Western European characters and refuses unsupported characters rather than substituting them. Adopted conservative visibility default pending ct: hidden-detail invoices also refuse their customer invoice-answer evidence doors; operator evidence remains complete.

### RL-107 — Exact customer mandate and independent collection approval

Date: 2026-10-28 · Ruler: ct · Governs: PAY-003

Question: May current automatic-collection preparation require exact customer acceptance and an independent approver without automatic retry or catch-up?

Default adopted/proposed: Exact per-invoice hosted customer consent; fresh-factor owner preparation; independent owner/finance approval or explicit sole-owner confirmation only with no other approver; no retry or missed-date catch-up.

Outcome: **adopt with rider** — Approve the proposed default subject to the precise conditions below.

Normative outcome: Approve that current collection custody: bind acceptance/approval to the exact invoice, method, processor account, amount and issue date; changed terms invalidate it; unknown outcomes permit provider reads only and block a duplicate attempt; ACH is pending until authenticated provider confirmation and returns reopen the balance. Archive attempts remain evidence and restored local debit authority is inactive.

Why and incumbent comparison: Stripe requires ACH mandates and verified bank accounts and distinguishes delayed ACH confirmation from immediate card outcomes. No common norm requires a second human approval per invoice; this stricter current default must not replace the full policy-authorized automatic collection target. Future recurring mandates may be built only with explicit scope, revocation and unchanged-terms proof.

Placement (one copy): Put collection-specific consent/uncertainty once in PAY-003; cite GOV-002 and existing restore custody.

Engineering/proof: The real test-clock T+4 assertion is a provider-proof limitation, not a pending policy choice or a passed timing test. Keep it explicit; existing pending-attempt restore proof and complete automatic-collection target remain owed.

Sources:
- [https://docs.stripe.com/payments/ach-direct-debit](https://docs.stripe.com/payments/ach-direct-debit) — Stripe requires debit authorization and bank verification; ACH is delayed notification and standard settlement is T+4, with eligible alternatives.
- [https://docs.stripe.com/invoicing/integration/automatic-advancement-collection](https://docs.stripe.com/invoicing/integration/automatic-advancement-collection) — Stripe exposes explicit automatic-advancement configuration, separately controlling finalization, charging and notices.

Observed clauses and complete Status Gaps:

- PAY-003: CONTRACT.md:256; Status at line 643. Gap: Four-business-day ACH settlement on the real Stripe test clock remains unproved: the held-key journey advanced T+3 and T+4, but Stripe's PaymentIntent and funds availability followed real time, with available_on 1792993943 rather than the fourth business day. Stripe documents that test-clock advancement does not support bank-debit collection. This is a provider proof dependency, not a passed timing assertion. Direct archive restoration of pending attempts remains unproved. Adopted conservative default pending ct: exact per-invoice hosted customer consent plus fresh-factor owner preparation and independent human approval, with explicit sole-owner confirmation only when no other approver exists; no retry or missed-date catch-up.
